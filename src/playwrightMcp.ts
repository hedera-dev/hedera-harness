import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLAYWRIGHT_MCP_NAME = "playwright";
export const PLAYWRIGHT_MCP_COMMAND = ["npx", "-y", "@playwright/mcp@latest"] as const;

export type PlaywrightMcpKind = "ready" | "disabled" | "missing";

export interface PlaywrightMcpHit {
  file: string;
  name: string;
  /** `mcp` (OpenCode v1) or `mcp.servers` (v2). */
  container: "mcp" | "mcp.servers";
  enabled: boolean;
}

export interface PlaywrightMcpStatus {
  kind: PlaywrightMcpKind;
  hits: PlaywrightMcpHit[];
  projectConfig: string;
  userConfig: string;
  restartHint: string;
}

export interface PlaywrightMcpOptions {
  /** Override ~/.config/opencode/opencode.json. Tests must pass a temp path. */
  userConfigPath?: string;
}

export function userOpencodeConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}

export function projectOpencodeConfigPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), "opencode.json");
}

export function inspectPlaywrightMcp(
  workspaceDir: string,
  options?: PlaywrightMcpOptions,
): PlaywrightMcpStatus {
  const projectConfig = projectOpencodeConfigPath(workspaceDir);
  const userConfig = options?.userConfigPath ?? userOpencodeConfigPath();
  const hits: PlaywrightMcpHit[] = [];
  for (const file of uniquePaths([
    projectConfig,
    path.join(path.resolve(workspaceDir), ".opencode", "opencode.json"),
    userConfig,
  ])) {
    hits.push(...findPlaywrightHits(file));
  }
  const enabled = hits.filter(hit => hit.enabled);
  const disabled = hits.filter(hit => !hit.enabled);
  const kind: PlaywrightMcpKind = enabled.length > 0 ? "ready" : disabled.length > 0 ? "disabled" : "missing";
  return {
    kind,
    hits,
    projectConfig,
    userConfig,
    restartHint:
      "OpenCode loads MCP at session start. After enable/install, start a new opencode session for the tools to appear.",
  };
}

export function formatPlaywrightMcpStatus(status: PlaywrightMcpStatus): string {
  const hitLines =
    status.hits.length === 0
      ? ["hit=none"]
      : status.hits.map(
          hit =>
            `hit=${hit.enabled ? "on" : "off"} name=${hit.name} container=${hit.container} file=${hit.file}`,
        );
  return [
    `kind=${status.kind}`,
    ...hitLines,
    `project_config=${status.projectConfig}`,
    `user_config=${status.userConfig}`,
    `restart=${status.restartHint}`,
    "e2e=playwright-mcp",
  ].join("\n");
}

/** Flip enabled:true / disabled:false on the first disabled Playwright MCP entry. */
export function enablePlaywrightMcp(
  workspaceDir: string,
  options?: PlaywrightMcpOptions,
): PlaywrightMcpStatus {
  const before = inspectPlaywrightMcp(workspaceDir, options);
  const disabled = before.hits.find(hit => !hit.enabled);
  if (!disabled) return inspectPlaywrightMcp(workspaceDir, options);
  const parsed = readJsonObject(disabled.file);
  const entry = locateEntry(parsed, disabled);
  if (entry) {
    entry.record.enabled = true;
    if ("disabled" in entry.record) delete entry.record.disabled;
  }
  const tools = parsed.tools;
  if (tools && typeof tools === "object" && !Array.isArray(tools)) {
    const bag = tools as Record<string, unknown>;
    for (const key of Object.keys(bag)) {
      if (/playwright/i.test(key) && bag[key] === false) bag[key] = true;
    }
  }
  writeJsonObject(disabled.file, parsed);
  return inspectPlaywrightMcp(workspaceDir, options);
}

/** Add Playwright MCP to the project opencode.json (does not write ~/.config/opencode). */
export function installPlaywrightMcp(
  workspaceDir: string,
  options?: PlaywrightMcpOptions,
): PlaywrightMcpStatus {
  const before = inspectPlaywrightMcp(workspaceDir, options);
  if (before.kind === "disabled") return enablePlaywrightMcp(workspaceDir, options);
  if (before.kind === "ready") return before;
  const file = projectOpencodeConfigPath(workspaceDir);
  const parsed = existsSync(file) ? readJsonObject(file) : {};
  const servers = asRecord(parsed.mcp) && asRecord(asRecord(parsed.mcp)?.servers);
  const snippet: Record<string, unknown> = {
    type: "local",
    command: [...PLAYWRIGHT_MCP_COMMAND],
    enabled: true,
  };
  if (servers) {
    const next = { ...asRecord(servers[PLAYWRIGHT_MCP_NAME]), ...snippet };
    delete next.disabled;
    servers[PLAYWRIGHT_MCP_NAME] = next;
  } else {
    const mcp = asRecord(parsed.mcp) ?? {};
    const next = { ...asRecord(mcp[PLAYWRIGHT_MCP_NAME]), ...snippet };
    delete next.disabled;
    mcp[PLAYWRIGHT_MCP_NAME] = next;
    parsed.mcp = mcp;
  }
  writeJsonObject(file, parsed);
  return inspectPlaywrightMcp(workspaceDir, options);
}

function findPlaywrightHits(file: string): PlaywrightMcpHit[] {
  if (!existsSync(file)) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = readJsonObject(file);
  } catch {
    return [];
  }
  const hits: PlaywrightMcpHit[] = [];
  const mcp = asRecord(parsed.mcp);
  if (!mcp) return hits;
  const servers = asRecord(mcp.servers);
  if (servers) {
    for (const [name, value] of Object.entries(servers)) {
      if (!isPlaywrightName(name)) continue;
      hits.push({
        file,
        name,
        container: "mcp.servers",
        enabled: isEntryEnabled(value, parsed.tools, name),
      });
    }
  }
  for (const [name, value] of Object.entries(mcp)) {
    if (name === "servers") continue;
    if (!isPlaywrightName(name)) continue;
    hits.push({
      file,
      name,
      container: "mcp",
      enabled: isEntryEnabled(value, parsed.tools, name),
    });
  }
  return hits;
}

function isPlaywrightName(name: string): boolean {
  return /playwright/i.test(name);
}

function isEntryEnabled(value: unknown, tools: unknown, name: string): boolean {
  const record = asRecord(value) ?? {};
  if (record.enabled === false || record.disabled === true) return false;
  const bag = asRecord(tools);
  if (bag) {
    if (bag[name] === false) return false;
    for (const [key, flag] of Object.entries(bag)) {
      if (flag === false && key.endsWith("*") && name.startsWith(key.slice(0, -1)) && /playwright/i.test(key)) {
        return false;
      }
    }
  }
  return true;
}

function locateEntry(
  parsed: Record<string, unknown>,
  hit: PlaywrightMcpHit,
): { record: Record<string, unknown> } | undefined {
  const mcp = asRecord(parsed.mcp);
  if (!mcp) return undefined;
  if (hit.container === "mcp.servers") {
    const servers = asRecord(mcp.servers);
    const record = asRecord(servers?.[hit.name]);
    return record ? { record } : undefined;
  }
  const record = asRecord(mcp[hit.name]);
  return record ? { record } : undefined;
}

function uniquePaths(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const key = path.normalize(file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readJsonObject(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonObject(file: string, value: Record<string, unknown>): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
