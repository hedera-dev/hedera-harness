import path from "node:path";
import { access } from "node:fs/promises";
import { commandExists, readGitRepoSnapshot } from "./harnessGit.js";
import { loadTemplateSpec } from "./specLoader.js";
import { AGENT_PRESETS } from "./specDefaults.js";
import { resolvePackageInstallTool } from "./optionalDeps.js";
import { isValidatorEnabled } from "./semanticValidator.js";
import {
  PROJECT_PROMPTS_DIR,
  PROMPT_TEMPLATE_NAMES,
  resolvePromptTemplatePath,
} from "./promptTemplates.js";
import type { ChainValidationConfig, CliOptions, TemplateSpec } from "./types.js";

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
export async function runDoctor(
  options: CliOptions,
  mode: { recipeOnly?: boolean } = {},
): Promise<DoctorReport> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const checks: DoctorCheck[] = [];

  const loaded = await loadRecipe(options.specPath, checks);
  const spec = loaded?.spec;

  // CI checks recipes across template branches without building each app, so
  // host and project checks would all fail for reasons unrelated to the recipe.
  if (mode.recipeOnly) {
    return { checks, passed: checks.every(check => check.status !== "fail") };
  }

  checks.unshift(checkNodeVersion());
  checks.splice(
    1,
    0,
    await checkCommand("git", workspacePath, "git is required for branch and checkpoint handling."),
  );
  checks.push(await checkGitRepo(workspacePath));

  if (spec) {
    checks.push(await checkAgentCli(spec, workspacePath));
    checks.push(await checkPackageManager(spec, workspacePath));
    checks.push(...(await checkRecipeFiles(spec)));
    checks.push(await checkPromptOverrides(spec.projectRoot));
    checks.push(...(await checkOptionalDeps(spec, workspacePath)));
    checks.push(...(await checkChainOperator(spec)));
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

/**
 * Report prompt overrides.
 *
 * An override is a copy, so it does not receive later changes to the bundled
 * prompt — including new variables, which would render as empty. Worth stating
 * plainly rather than leaving someone to discover it from a degraded prompt.
 */
async function checkPromptOverrides(projectRoot: string): Promise<DoctorCheck> {
  const overridden: string[] = [];
  for (const name of PROMPT_TEMPLATE_NAMES) {
    const resolved = await resolvePromptTemplatePath(projectRoot, name);
    if (resolved.overridden) overridden.push(name);
  }

  if (overridden.length === 0) {
    return { name: "prompts", status: "ok", detail: "using bundled prompts" };
  }

  return {
    name: "prompts",
    status: "warn",
    detail: `${overridden.length} override(s): ${overridden.join(", ")}`,
    fix: `Overrides in ${PROJECT_PROMPTS_DIR}/ do not track harness updates — re-check them after upgrading.`,
  };
}

async function checkOptionalDeps(spec: TemplateSpec, cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const tool = await resolvePackageInstallTool({
    projectRoot: cwd,
    packageManager: spec.constraints?.packageManager,
  });

  let tier2PlaywrightAvailable = false;
  if (spec.validators.playwrightPath) {
    const dependency = await checkImport("playwright", "Tier 2 Playwright gate", tool);
    checks.push(dependency);
    tier2PlaywrightAvailable = dependency.status === "ok";
  }
  if (isValidatorEnabled(spec)) {
    checks.push(await checkMcpBrowser(cwd, tool));
  } else if (tier2PlaywrightAvailable) {
    checks.push(await checkTier2Browser(cwd));
  }
  if (spec.chainValidation?.enabled) {
    checks.push(await checkImport("@hiero-ledger/sdk", "Tier 3.5 on-chain validation", tool));
  }
  return checks;
}

/**
 * Start the MCP server and navigate for real.
 *
 * The Tier 2 gate passing says nothing about Tier 3: they used to resolve
 * different browsers, so the gate could go green while the validator had
 * nothing to drive — surfacing only after a paid agent session.
 */
async function checkMcpBrowser(projectRoot: string, installTool: string): Promise<DoctorCheck> {
  const { probeMcpBrowser } = await import("./mcpBrowser.js");
  const probe = await probeMcpBrowser(projectRoot);

  if (probe.ok) {
    return {
      name: "Tier 3 browser (Playwright MCP)",
      status: "ok",
      detail: probe.choice.detail,
    };
  }

  return {
    name: "Tier 3 browser (Playwright MCP)",
    status: "fail",
    detail: probe.error ?? "the Playwright MCP browser could not be launched",
    fix:
      probe.choice.source === "project-playwright"
        ? "Reinstall the project's browser: npx playwright install chromium"
        : `Install Playwright in the project so Tier 2 and Tier 3 share one browser: ${installTool} add -D playwright && npx playwright install chromium`,
  };
}

async function checkTier2Browser(projectRoot: string): Promise<DoctorCheck> {
  const { launchSharedBrowser, resolveMcpBrowser } = await import("./mcpBrowser.js");
  const choice = await resolveMcpBrowser(projectRoot);
  try {
    const browser = await launchSharedBrowser(projectRoot);
    await browser.close();
    return {
      name: "Tier 2 browser",
      status: "ok",
      detail: choice.detail,
    };
  } catch (error) {
    return {
      name: "Tier 2 browser",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix:
        choice.source === "project-playwright"
          ? "Reinstall the project's browser: npx playwright install chromium"
          : "Install system Chrome, or install the project's Playwright browser: npx playwright install chromium",
    };
  }
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

function checkChainEnv(chain: ChainValidationConfig): DoctorCheck[] {
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

/**
 * Verify the chainValidation operator before a run pays for one.
 *
 * The run itself only discovers a bad operator at Tier 3.5 provisioning —
 * after baseline installs and builds. A wrong key (INVALID_SIGNATURE), a
 * mistyped or non-existent account, or too little HBAR to fund the ephemeral
 * signer are all knowable in one mirror-node read, so doctor checks them here.
 */
async function checkChainOperator(spec: TemplateSpec): Promise<DoctorCheck[]> {
  const chain = spec.chainValidation;
  if (!chain?.enabled) return [];

  const checks = checkChainEnv(chain);
  if (checks.some(check => check.status !== "ok")) return checks;

  checks.push(await checkOperatorOnChain(chain));
  return checks;
}

const MIRROR_ACCOUNTS_URL = "https://testnet.mirrornode.hedera.com/api/v1/accounts/";

async function checkOperatorOnChain(chain: ChainValidationConfig): Promise<DoctorCheck> {
  const name = "operator (chainValidation)";
  const accountId = process.env[chain.operator.accountIdEnv]?.trim() ?? "";
  const privateKeyRaw = process.env[chain.operator.privateKeyEnv]?.trim() ?? "";

  // Same format rules and wording the run enforces at its start.
  try {
    const { assertChainValidationOperatorEnv } = await import("./validation/chainSigner.js");
    assertChainValidationOperatorEnv(chain);
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // Parse the key locally when the SDK is present (its absence has its own check).
  let publicKeyHex: string | undefined;
  try {
    const sdk = await import("@hiero-ledger/sdk");
    const { parseOperatorPrivateKey } = await import("./validation/chainSigner.js");
    try {
      publicKeyHex = parseOperatorPrivateKey(sdk, privateKeyRaw, chain.operator.privateKeyEnv)
        .publicKey.toStringRaw()
        .toLowerCase();
    } catch (error) {
      return {
        name,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } catch {
    // SDK not installed — reported by checkOptionalDeps; key match is skipped.
  }

  let response: Response;
  try {
    response = await fetch(`${MIRROR_ACCOUNTS_URL}${accountId}`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return {
      name,
      status: "warn",
      detail: `could not reach the testnet mirror node to verify ${accountId}`,
      fix: "On-chain operator checks were skipped — a run may still work once connectivity is back.",
    };
  }

  if (response.status === 404) {
    return {
      name,
      status: "fail",
      detail: `account ${accountId} does not exist on testnet`,
      fix: "Create and fund a testnet ECDSA account at https://portal.hedera.com, then use its Account ID.",
    };
  }
  if (!response.ok) {
    return {
      name,
      status: "warn",
      detail: `mirror node returned HTTP ${response.status} for ${accountId} — on-chain checks skipped`,
    };
  }

  const account = (await response.json()) as {
    key?: { _type?: string; key?: string };
    balance?: { balance?: number };
  };

  if (account.key?._type === "ED25519") {
    return {
      name,
      status: "fail",
      detail: `account ${accountId} uses an ED25519 key`,
      fix: "chainValidation requires an ECDSA operator — ED25519 has no EVM alias. Create an ECDSA account at https://portal.hedera.com.",
    };
  }

  if (publicKeyHex && account.key?.key && account.key.key.toLowerCase() !== publicKeyHex) {
    return {
      name,
      status: "fail",
      detail: `the key in $${chain.operator.privateKeyEnv} does not match account ${accountId}`,
      fix: "Provisioning would fail with INVALID_SIGNATURE. Use the private key that owns this account, or fix the account ID.",
    };
  }

  const balanceHbar = (account.balance?.balance ?? 0) / 100_000_000;
  if (balanceHbar < chain.fundingHbar + 1) {
    return {
      name,
      status: "fail",
      detail: `account ${accountId} holds ${balanceHbar.toFixed(2)} ℏ — funding the ephemeral signer needs fundingHbar (${chain.fundingHbar} ℏ) plus fees`,
      fix: "Top up the operator at https://portal.hedera.com, or lower chainValidation.fundingHbar.",
    };
  }

  return {
    name,
    status: "ok",
    detail: `${accountId} — ${publicKeyHex ? "key matches, " : ""}${balanceHbar.toFixed(2)} ℏ`,
  };
}
