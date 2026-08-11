import path from "node:path";
import { access } from "node:fs/promises";
import { commandExists, readGitRepoSnapshot } from "./harnessGit.js";
import { loadTemplateSpec } from "./specLoader.js";
import { AGENT_PRESETS } from "./specDefaults.js";
import { resolvePackageInstallTool } from "./optionalDeps.js";
import type { CliOptions, TemplateSpec } from "./types.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Shown only when the check did not pass. */
  fix?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** False when any check failed outright. */
  passed: boolean;
}

/**
 * Preflight everything a run needs, before committing to one.
 *
 * `run` already validates most of this, but only after creating a branch and
 * starting baseline commands — and a real run costs 40 minutes to two hours.
 * Learning that the agent CLI is not on PATH should take two seconds.
 */
export async function runDoctor(options: CliOptions): Promise<DoctorReport> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion());
  checks.push(await checkCommand("git", workspacePath, "git is required for branch and checkpoint handling."));

  const loaded = await loadRecipe(options.specPath, checks);
  const spec = loaded?.spec;

  checks.push(await checkGitRepo(workspacePath));

  if (spec) {
    checks.push(await checkAgentCli(spec, workspacePath));
    checks.push(await checkPackageManager(spec, workspacePath));
    checks.push(...(await checkRecipeFiles(spec)));
    checks.push(...(await checkOptionalDeps(spec, workspacePath)));
    checks.push(...checkChainEnv(spec));
  }

  return { checks, passed: checks.every(check => check.status !== "fail") };
}

export function formatDoctorReport(report: DoctorReport): string {
  const symbol: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✘" };
  const lines = report.checks.map(check => {
    const head = `  ${symbol[check.status]} ${check.name} — ${check.detail}`;
    return check.status === "ok" || !check.fix ? head : `${head}\n      ${check.fix}`;
  });

  const failed = report.checks.filter(check => check.status === "fail").length;
  const warned = report.checks.filter(check => check.status === "warn").length;

  return [
    "hedera-harness doctor",
    "",
    ...lines,
    "",
    report.passed
      ? warned > 0
        ? `Ready to run (${warned} warning(s)).`
        : "Ready to run."
      : `${failed} check(s) failed — \`run\` would not get past preflight.`,
  ].join("\n");
}

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return major >= 20
    ? { name: "node", status: "ok", detail: `v${process.versions.node}` }
    : {
        name: "node",
        status: "fail",
        detail: `v${process.versions.node} is too old`,
        fix: "The harness requires Node.js 20 or newer.",
      };
}

async function checkCommand(command: string, cwd: string, why: string): Promise<DoctorCheck> {
  return (await commandExists(command, cwd))
    ? { name: command, status: "ok", detail: "on PATH" }
    : { name: command, status: "fail", detail: "not on PATH", fix: why };
}

async function loadRecipe(
  specPath: string,
  checks: DoctorCheck[],
): Promise<Awaited<ReturnType<typeof loadTemplateSpec>> | undefined> {
  try {
    const loaded = await loadTemplateSpec(specPath);
    checks.push({
      name: "recipe",
      status: loaded.warnings.length > 0 ? "warn" : "ok",
      detail:
        loaded.warnings.length > 0
          ? `${loaded.specPath} loads with ${loaded.warnings.length} warning(s)`
          : `${loaded.specPath} (schema v${loaded.spec.schemaVersion})`,
      fix: loaded.warnings.length > 0 ? loaded.warnings.join("\n      ") : undefined,
    });
    return loaded;
  } catch (error) {
    checks.push({
      name: "recipe",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Fix the recipe, or bootstrap one with `hedera-harness init`.",
    });
    return undefined;
  }
}

async function checkGitRepo(workspacePath: string): Promise<DoctorCheck> {
  try {
    const snapshot = await readGitRepoSnapshot(workspacePath);
    if (snapshot.detached) {
      return {
        name: "git repo",
        status: "fail",
        detail: "HEAD is detached",
        fix: "Check out a branch — the harness records its work on one.",
      };
    }
    if (snapshot.inProgressOperation) {
      return {
        name: "git repo",
        status: "fail",
        detail: `a ${snapshot.inProgressOperation} is in progress`,
        fix: "Finish or abort it first.",
      };
    }
    return { name: "git repo", status: "ok", detail: `on ${snapshot.branch}` };
  } catch (error) {
    return {
      name: "git repo",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Run from inside a git repository (`hedera-harness init` creates one).",
    };
  }
}

async function checkAgentCli(spec: TemplateSpec, cwd: string): Promise<DoctorCheck> {
  const command = spec.generator.command?.trim() || AGENT_PRESETS[spec.agent].command;

  // Absolute paths and npx-style wrappers are not resolvable this way.
  if (command.includes("/") || command.includes("\\")) {
    return { name: `agent (${spec.agent})`, status: "ok", detail: `${command} (not checked)` };
  }

  return (await commandExists(command, cwd))
    ? { name: `agent (${spec.agent})`, status: "ok", detail: `${command} on PATH` }
    : {
        name: `agent (${spec.agent})`,
        status: "fail",
        detail: `${command} is not on PATH`,
        fix: `Install and authenticate the ${spec.agent} CLI, or set a different \`agent:\` in the recipe.`,
      };
}

async function checkPackageManager(spec: TemplateSpec, cwd: string): Promise<DoctorCheck> {
  const declared = spec.constraints?.packageManager?.trim();
  const binary = declared ? (declared.split("@")[0] || declared) : await resolvePackageInstallTool({ projectRoot: cwd });

  return (await commandExists(binary, cwd))
    ? { name: "package manager", status: "ok", detail: `${binary} on PATH` }
    : {
        name: "package manager",
        status: "fail",
        detail: `${binary} is not on PATH`,
        fix: declared
          ? `The recipe declares constraints.packageManager: ${declared}.`
          : "Detected from the project's lockfile.",
      };
}

async function checkRecipeFiles(spec: TemplateSpec): Promise<DoctorCheck[]> {
  const targets: Array<[string, string | undefined]> = [
    ...spec.prdPaths.map((prd, i): [string, string] => [`prd${spec.prdPaths.length > 1 ? `[${i}]` : ""}`, prd]),
    ["validators.static", spec.validators.staticPath],
    ["validators.commands", spec.validators.commandsPath],
    ["validators.playwright", spec.validators.playwrightPath],
    ["contract", spec.contractPath],
  ];

  const checks: DoctorCheck[] = [];
  for (const [label, target] of targets) {
    if (!target) continue;
    try {
      await access(target);
      checks.push({ name: label, status: "ok", detail: "present" });
    } catch {
      checks.push({
        name: label,
        status: "fail",
        detail: `missing: ${target}`,
        fix: "The recipe points at a file that does not exist.",
      });
    }
  }
  return checks;
}

async function checkOptionalDeps(spec: TemplateSpec, cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const tool = await resolvePackageInstallTool({
    projectRoot: cwd,
    packageManager: spec.constraints?.packageManager,
  });

  if (spec.validators.playwrightPath) {
    checks.push(await checkImport("playwright", "Tier 2 Playwright gate", tool));
  }
  if (spec.chainValidation?.enabled) {
    checks.push(await checkImport("@hiero-ledger/sdk", "Tier 3.5 on-chain validation", tool));
  }
  return checks;
}

async function checkImport(pkg: string, feature: string, tool: string): Promise<DoctorCheck> {
  try {
    await import(pkg);
    return { name: pkg, status: "ok", detail: `available for ${feature}` };
  } catch {
    return {
      name: pkg,
      status: "fail",
      detail: `not installed, required by ${feature}`,
      fix: `${tool} add -D ${pkg}`,
    };
  }
}

function checkChainEnv(spec: TemplateSpec): DoctorCheck[] {
  const chain = spec.chainValidation;
  if (!chain?.enabled) return [];

  return [chain.operator.accountIdEnv, chain.operator.privateKeyEnv].map(name => {
    const value = process.env[name]?.trim();
    return value
      ? { name, status: "ok" as const, detail: "set" }
      : {
          name,
          status: "fail" as const,
          detail: "not set",
          fix: `Required by chainValidation. Testnet credentials from https://portal.hedera.com.`,
        };
  });
}
