import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../initRunner.js";
import { OPENZEPPELIN_MCP_NAME, OPENZEPPELIN_MCP_URL } from "../ozMcp.js";
import { formatYarnInstallReport, runYarnInstallForeground } from "../yarnInstall.js";
import type { TuiCliOptions } from "../types.js";

export const HEDERA_DOCS_MCP_NAME = "hedera-docs";
export const HEDERA_DOCS_MCP_URL = "https://docs.hedera.com/mcp";
export { OPENZEPPELIN_MCP_NAME, OPENZEPPELIN_MCP_URL };
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POINTER_NAME = "hedera-harness.json";
const AGENTS_START = "<!-- hedera-harness-tui:start -->";
const AGENTS_END = "<!-- hedera-harness-tui:end -->";
const AGENTS_BODY = `${AGENTS_START}
# OpenCode

This repo is a **hedera-harness** workspace. Tab to **hedera-orchestrator**. Loop: INIT → PRD → GENERATE (one \`.harness/tasks.md\` unit at a time) → ASSERT → SMOKE → Playwright MCP E2E (install/enable or skip) → RainbowKit Connect+Send in the human's Chrome (EVM).

Slash: \`/harness-init\` \`/harness-run\` \`/harness-status\` \`/harness-wallet\` \`/harness-local\`

The orchestrator asks **what to build** first (custom idea first). A starter chip is a seed, not a skip. Interview **one question at a time** until they confirm **Así está**. The first app’s UI is **their** dApp on the scaffold chassis (reuse components; do not ship the seed Home plus an extra route). The init \`.harness/prd.md\` (“edit me”) is not a PRD. Then Automatic vs Step by step.

\`harness_wallet_gate\` must be \`gate=ok\` before PRD/GENERATE (even if INIT was skipped). GENERATE walks \`.harness/tasks.md\` one unit at a time. Final automated E2E is Playwright MCP (install/enable or skip). **Hedera docs: \`SearchHedera\` (\`hedera-docs\`) first** — \`websearch\` is forbidden for Hedera while that tool is in the session. Fallback to \`docs.hedera.com\` only if MCP is missing or the call failed. Never read \`.harness/wallet/\` private keys.
${AGENTS_END}
`;

export interface TuiPointer {
  schemaVersion: 1;
  harnessRoot: string;
  cli: string;
  keepDefault: boolean;
  previousDefaultAgent?: string;
  createdOpencodeJson: boolean;
  createdAgentsMd: boolean;
  installedAt: string;
}

export interface TuiOverlayResult {
  targetDir: string;
  writtenFiles: string[];
  removedFiles: string[];
  keepDefault: boolean;
  inited: boolean;
  yarnInstall?: string;
  nextSteps: string[];
}

export function harnessPackageRoot(): string {
  return PACKAGE_ROOT;
}

export function printTuiHelp(): void {
  console.log(`hedera-harness tui

Usage:
  hedera-harness tui install [target-dir] [--keep-default] [--no-init] [--skip-install]
  hedera-harness tui uninstall [target-dir]

Copies the OpenCode overlay (opencode.json + .opencode/) into a project so
\`opencode\` there shows hedera-orchestrator and /harness-* commands.

If the target has no \`.harness/spec.yaml\`, clones/adopts the scaffold first,
then copies the overlay, then runs \`yarn install\` with **no timeout**
(it takes as long as it needs). When yarn finishes, open the project in
OpenCode. Use --no-init to copy the overlay only (yarn still runs unless
--skip-install).

Does not write ~/.config/opencode — Gentle's global overlay stays intact.
--keep-default leaves default_agent alone so Tab still starts on Gentle.

Examples:
  hedera-harness tui install
  hedera-harness tui install D:\\my-dapp
  hedera-harness tui install ./test-app --keep-default
  hedera-harness tui uninstall`);
}

export async function runTuiCommand(options: TuiCliOptions): Promise<void> {
  if (options.subcommand === "install") {
    const result = await installTuiOverlay(options);
    console.log(
      [
        "OpenCode overlay installed",
        `target=${result.targetDir}`,
        `filesWritten=${result.writtenFiles.length}`,
        result.keepDefault ? "default_agent=unchanged (Tab to hedera-orchestrator)" : "default_agent=hedera-orchestrator",
        result.inited
          ? "init=scaffold or .harness/ ready"
          : "init=skipped (recipe already present or --no-init)",
        result.yarnInstall,
        "",
        "Next steps:",
        ...result.nextSteps.map(step => `  ${step}`),
      ]
        .filter(line => line !== undefined)
        .join("\n"),
    );
    return;
  }

  const result = await uninstallTuiOverlay(options);
  if (result.removedFiles.length === 0) {
    console.log(`No hedera-harness OpenCode overlay found in ${result.targetDir}`);
    return;
  }
  console.log(
    [
      "OpenCode overlay removed",
      `target=${result.targetDir}`,
      `filesRemoved=${result.removedFiles.length}`,
      "",
      "Gentle / ~/.config/opencode was not touched.",
    ].join("\n"),
  );
}

export function needsHarnessInit(targetDir: string): boolean {
  return !existsSync(path.join(path.resolve(targetDir), ".harness", "spec.yaml"));
}

export async function installTuiOverlay(options: TuiCliOptions): Promise<TuiOverlayResult> {
  const targetDir = resolveTarget(options.targetDir);
  if (path.resolve(targetDir) === path.resolve(PACKAGE_ROOT)) {
    throw new Error(
      "The OpenCode overlay already lives in the hedera-harness package. Install it into another project: `hedera-harness tui install <dir>`.",
    );
  }

  const willInit = options.skipInit !== true && needsHarnessInit(targetDir);
  await assertInstallableDirectory(targetDir, { allowMissing: willInit });
  let inited = false;
  if (willInit) {
    try {
      await runInit({
        targetDir,
        // Overlay must copy even if yarn would be slow. Yarn runs after the
        // overlay is on disk, in this CLI process, with no timeout.
        skipInstall: true,
        skipSkills: options.skipSkills === true,
      });
      inited = true;
    } catch (error) {
      if (!existsSync(path.join(targetDir, "package.json"))) {
        throw error;
      }
    }
  }
  await assertInstallableDirectory(targetDir);
  const sourceOverlay = path.join(PACKAGE_ROOT, ".opencode");
  const sourceConfig = path.join(PACKAGE_ROOT, "opencode.json");
  if (!existsSync(sourceOverlay) || !existsSync(sourceConfig)) {
    throw new Error(
      "OpenCode overlay templates missing from the hedera-harness package (.opencode/ + opencode.json).",
    );
  }

  const writtenFiles: string[] = [];
  const destOverlay = path.join(targetDir, ".opencode");
  await mkdir(destOverlay, { recursive: true });
  writtenFiles.push(...(await copyManagedOverlay(sourceOverlay, destOverlay)));

  const opencodePath = path.join(targetDir, "opencode.json");
  const existedConfig = existsSync(opencodePath);
  let previousDefaultAgent: string | undefined;
  if (existedConfig) {
    try {
      const existing = JSON.parse(await readFile(opencodePath, "utf8")) as Record<string, unknown>;
      if (typeof existing.default_agent === "string") {
        previousDefaultAgent = existing.default_agent;
      }
    } catch {
      // merge writer will throw on invalid JSON
    }
  }
  await writeMergedOpencodeJson(sourceConfig, opencodePath, Boolean(options.keepDefault));
  writtenFiles.push("opencode.json");

  const agentsPath = path.join(targetDir, "AGENTS.md");
  const existedAgents = existsSync(agentsPath);
  await upsertAgentsBlock(agentsPath);
  writtenFiles.push("AGENTS.md");

  const pointer: TuiPointer = {
    schemaVersion: 1,
    harnessRoot: PACKAGE_ROOT,
    cli: path.join(PACKAGE_ROOT, "dist", "index.js"),
    keepDefault: Boolean(options.keepDefault),
    ...(previousDefaultAgent ? { previousDefaultAgent } : {}),
    createdOpencodeJson: !existedConfig,
    createdAgentsMd: !existedAgents,
    installedAt: new Date().toISOString(),
  };
  const pointerRel = path.join(".opencode", POINTER_NAME);
  await writeFile(path.join(targetDir, pointerRel), `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  writtenFiles.push(pointerRel);

  let yarnInstall: string | undefined;
  if (options.skipInstall !== true) {
    console.log("[hedera-harness] yarn install (no timeout) — wait here. Open OpenCode only after this finishes.");
    const yarn = await runYarnInstallForeground(targetDir);
    yarnInstall = formatYarnInstallReport(yarn);
    if (yarn.kind === "fail") {
      throw new Error(`yarn install failed after overlay copy.\n${yarnInstall}`);
    }
    console.log("[hedera-harness] yarn install finished — you can open this project in OpenCode now.");
  }

  const yarnReady = options.skipInstall !== true;
  return {
    targetDir,
    writtenFiles: uniqueSorted(writtenFiles),
    removedFiles: [],
    keepDefault: Boolean(options.keepDefault),
    inited,
    yarnInstall,
    nextSteps: yarnReady
      ? [
          "Dependencies are ready. You can open this project in OpenCode now.",
          `cd ${targetDir}`,
          "opencode",
          options.keepDefault
            ? "Tab to hedera-orchestrator, then /harness-run"
            : "Tab should already be hedera-orchestrator — /harness-run",
        ]
      : [
          "Do not open OpenCode yet — deps were skipped (--skip-install).",
          `cd ${targetDir}`,
          "yarn install",
          "When yarn finishes, open this folder in OpenCode.",
        ],
  };
}

export async function uninstallTuiOverlay(options: TuiCliOptions): Promise<TuiOverlayResult> {
  const targetDir = resolveTarget(options.targetDir);
  if (path.resolve(targetDir) === path.resolve(PACKAGE_ROOT)) {
    throw new Error(
      "Refusing to uninstall the overlay from the hedera-harness package itself (that is the template source).",
    );
  }
  const removedFiles: string[] = [];
  const pointer = await readPointer(targetDir);

  const destOverlay = path.join(targetDir, ".opencode");
  if (existsSync(destOverlay)) {
    for (const rel of await listManagedRelativePaths(destOverlay)) {
      if (!isManagedOverlayRel(rel)) continue;
      const abs = path.join(destOverlay, rel);
      if (!existsSync(abs)) continue;
      await rm(abs, { recursive: true, force: true });
      removedFiles.push(path.join(".opencode", rel));
    }
    const pointerPath = path.join(destOverlay, POINTER_NAME);
    if (existsSync(pointerPath)) {
      await rm(pointerPath, { force: true });
      removedFiles.push(path.join(".opencode", POINTER_NAME));
    }
    await removeEmptyDirs(destOverlay);
    if (existsSync(destOverlay) && (await readdir(destOverlay)).length === 0) {
      await rm(destOverlay, { recursive: true, force: true });
      removedFiles.push(".opencode");
    }
  }

  const opencodePath = path.join(targetDir, "opencode.json");
  if (existsSync(opencodePath)) {
    const stripped = await stripOpencodeJson(opencodePath, pointer);
    if (stripped === "deleted") {
      removedFiles.push("opencode.json");
    } else if (stripped === "updated") {
      removedFiles.push("opencode.json (hedera-orchestrator removed)");
    }
  }

  const agentsPath = path.join(targetDir, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const agentsAction = await removeAgentsBlock(agentsPath, pointer?.createdAgentsMd === true);
    if (agentsAction !== "kept") {
      removedFiles.push(agentsAction === "deleted" ? "AGENTS.md" : "AGENTS.md (harness block removed)");
    }
  }

  return {
    targetDir,
    writtenFiles: [],
    removedFiles,
    keepDefault: Boolean(pointer?.keepDefault),
    inited: false,
    nextSteps: [],
  };
}

function resolveTarget(targetDir?: string): string {
  return path.resolve(targetDir ?? process.cwd());
}

async function assertInstallableDirectory(
  targetDir: string,
  options: { allowMissing?: boolean } = {},
): Promise<void> {
  const configHome = path.resolve(os.homedir(), ".config", "opencode");
  const resolved = path.resolve(targetDir);
  if (resolved === configHome || isInside(resolved, configHome)) {
    throw new Error(
      "Refusing to install into ~/.config/opencode (that is Gentle's overlay). Pass a project directory.",
    );
  }
  if (!existsSync(resolved)) {
    if (options.allowMissing) return;
    throw new Error(`Target directory does not exist: ${resolved}`);
  }
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error(`Target is not a directory: ${resolved}`);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function copyManagedOverlay(sourceOverlay: string, destOverlay: string): Promise<string[]> {
  const written: string[] = [];
  for (const rel of await listManagedRelativePaths(sourceOverlay)) {
    const from = path.join(sourceOverlay, rel);
    const to = path.join(destOverlay, rel);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true, force: true });
    written.push(path.join(".opencode", rel));
  }
  return written;
}

async function listManagedRelativePaths(overlayRoot: string): Promise<string[]> {
  const found: string[] = [];
  if (!existsSync(overlayRoot)) return found;
  await walkFiles(overlayRoot, overlayRoot, found);
  return found.filter(
    rel =>
      path.basename(rel) !== POINTER_NAME &&
      !rel.split(path.sep).includes("node_modules") &&
      isManagedOverlayRel(rel),
  );
}

async function walkFiles(root: string, current: string, out: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, abs, out);
      continue;
    }
    out.push(path.relative(root, abs));
  }
}

async function writeMergedOpencodeJson(
  sourceConfig: string,
  destConfig: string,
  keepDefault: boolean,
): Promise<void> {
  const overlay = JSON.parse(await readFile(sourceConfig, "utf8")) as Record<string, unknown>;
  const existing = existsSync(destConfig)
    ? (JSON.parse(await readFile(destConfig, "utf8")) as Record<string, unknown>)
    : {};
  const overlayAgent = (overlay.agent ?? {}) as Record<string, unknown>;
  const existingAgent = (existing.agent ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    ...existing,
    ...overlay,
    agent: {
      ...existingAgent,
      ...overlayAgent,
    },
    mcp: mergeMcpRecords(
      asJsonRecord(existing.mcp),
      asJsonRecord(overlay.mcp),
    ),
  };
  if (!merged.mcp) delete merged.mcp;
  if (keepDefault) {
    if (typeof existing.default_agent === "string" && existing.default_agent !== "hedera-orchestrator") {
      merged.default_agent = existing.default_agent;
    } else {
      delete merged.default_agent;
    }
  } else {
    merged.default_agent = "hedera-orchestrator";
  }
  await writeFile(destConfig, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function isManagedOverlayRel(rel: string): boolean {
  const n = rel.split(path.sep).join("/");
  return (
    n.startsWith("agents/hedera-") ||
    n.startsWith("commands/harness-") ||
    n.startsWith("skills/harness-") ||
    n.startsWith("prompts/hedera-") ||
    n === "plugins/hedera-harness.js"
  );
}

async function stripOpencodeJson(
  destConfig: string,
  pointer: TuiPointer | undefined,
): Promise<"deleted" | "updated" | "kept"> {
  const current = JSON.parse(await readFile(destConfig, "utf8")) as Record<string, unknown>;
  const agent = { ...((current.agent ?? {}) as Record<string, unknown>) };
  const hadHedera = Object.prototype.hasOwnProperty.call(agent, "hedera-orchestrator");
  const hadDefault = current.default_agent === "hedera-orchestrator";
  const strippedHedera = stripNamedMcp(current, HEDERA_DOCS_MCP_NAME);
  const strippedOz = stripNamedMcp(current, OPENZEPPELIN_MCP_NAME);
  const strippedPlaywright = stripNamedMcp(current, "playwright");
  const strippedMcp = strippedHedera || strippedOz || strippedPlaywright;
  delete agent["hedera-orchestrator"];
  if (Object.keys(agent).length === 0) {
    delete current.agent;
  } else {
    current.agent = agent;
  }
  if (hadDefault) {
    if (pointer?.previousDefaultAgent && pointer.previousDefaultAgent !== "hedera-orchestrator") {
      current.default_agent = pointer.previousDefaultAgent;
    } else {
      delete current.default_agent;
    }
  }
  if (!hadHedera && !hadDefault && !strippedMcp) {
    return "kept";
  }
  if (pointer?.createdOpencodeJson) {
    await rm(destConfig, { force: true });
    return "deleted";
  }
  await writeFile(destConfig, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return "updated";
}

async function upsertAgentsBlock(agentsPath: string): Promise<void> {
  if (!existsSync(agentsPath)) {
    await writeFile(agentsPath, `${AGENTS_BODY.trim()}\n`, "utf8");
    return;
  }
  const current = await readFile(agentsPath, "utf8");
  if (current.includes(AGENTS_START) && current.includes(AGENTS_END)) {
    const next = current.replace(
      new RegExp(`${escapeRegExp(AGENTS_START)}[\\s\\S]*?${escapeRegExp(AGENTS_END)}`),
      AGENTS_BODY.trim(),
    );
    await writeFile(agentsPath, next.endsWith("\n") ? next : `${next}\n`, "utf8");
    return;
  }
  const trimmed = current.trimEnd();
  await writeFile(agentsPath, `${trimmed}\n\n${AGENTS_BODY.trim()}\n`, "utf8");
}

async function removeAgentsBlock(
  agentsPath: string,
  createdByUs: boolean,
): Promise<"deleted" | "updated" | "kept"> {
  const current = await readFile(agentsPath, "utf8");
  if (!current.includes(AGENTS_START)) {
    if (createdByUs) {
      await rm(agentsPath, { force: true });
      return "deleted";
    }
    return "kept";
  }
  const next = current
    .replace(new RegExp(`\\n*${escapeRegExp(AGENTS_START)}[\\s\\S]*?${escapeRegExp(AGENTS_END)}\\n*`), "\n")
    .trim();
  if (!next) {
    await rm(agentsPath, { force: true });
    return "deleted";
  }
  await writeFile(agentsPath, `${next}\n`, "utf8");
  return "updated";
}

async function readPointer(targetDir: string): Promise<TuiPointer | undefined> {
  const pointerPath = path.join(targetDir, ".opencode", POINTER_NAME);
  if (!existsSync(pointerPath)) return undefined;
  try {
    return JSON.parse(await readFile(pointerPath, "utf8")) as TuiPointer;
  } catch {
    return undefined;
  }
}

async function removeEmptyDirs(root: string): Promise<void> {
  if (!existsSync(root)) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const abs = path.join(root, entry.name);
    await removeEmptyDirs(abs);
    const leftover = await readdir(abs);
    if (leftover.length === 0) {
      await rm(abs, { recursive: true, force: true });
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function mergeMcpRecords(
  existing?: Record<string, unknown>,
  overlay?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!existing && !overlay) return undefined;
  const a = existing ?? {};
  const b = overlay ?? {};
  const merged: Record<string, unknown> = { ...a, ...b };
  const serversA = asJsonRecord(a.servers);
  const serversB = asJsonRecord(b.servers);
  if (serversA || serversB) {
    merged.servers = { ...serversA, ...serversB };
  }
  return merged;
}

function stripNamedMcp(config: Record<string, unknown>, name: string): boolean {
  const mcp = asJsonRecord(config.mcp);
  if (!mcp) return false;
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(mcp, name)) {
    delete mcp[name];
    changed = true;
  }
  const servers = asJsonRecord(mcp.servers);
  if (servers && Object.prototype.hasOwnProperty.call(servers, name)) {
    delete servers[name];
    changed = true;
    if (Object.keys(servers).length === 0) delete mcp.servers;
    else mcp.servers = servers;
  }
  if (Object.keys(mcp).length === 0) delete config.mcp;
  else config.mcp = mcp;
  return changed;
}
