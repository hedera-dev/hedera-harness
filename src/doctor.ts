import { connect } from "node:net";
import path from "node:path";
import { commandExists, readGitRepoSnapshot } from "./harnessGit.js";
import { loadTemplateSpec } from "./specLoader.js";
import { isValidatorEnabled } from "./evaluation.js";
import { DEFAULT_LOCAL_CHAIN } from "./specDefaults.js";
import {
  checkSharedPreflight,
  type PreflightVerdict,
} from "./preflight.js";
import {
  PROJECT_PROMPTS_DIR,
  PROMPT_TEMPLATE_NAMES,
  resolvePromptTemplatePath,
} from "./promptTemplates.js";
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
 * Shared host/recipe/git/browser rules live in `checkSharedPreflight`; doctor
 * adds recipe load, prompt overrides, bundled Playwright / SDK imports, SMOKE
 * browser (when EVALUATE is off), and chain env.
 */
export async function runDoctor(
  options: CliOptions,
  mode: { recipeOnly?: boolean } = {},
): Promise<DoctorReport> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const recipe = await loadRecipe(options.specPath);

  // CI checks recipes across template branches without building each app, so
  // host and project checks would all fail for reasons unrelated to the recipe.
  if (mode.recipeOnly) {
    return {
      checks: [recipe.check],
      passed: recipe.check.status !== "fail",
    };
  }

  const checks: DoctorCheck[] = [];

  if (!recipe.spec) {
    // Still report host git basics when the recipe cannot load.
    checks.push(checkNodeVersionLocal());
    checks.push(
      await checkCommandLocal(
        "git",
        workspacePath,
        "git is required for branch and checkpoint handling.",
      ),
    );
    checks.push(await checkGitRepoLocal(workspacePath));
    checks.push(recipe.check);
    return { checks, passed: checks.every(check => check.status !== "fail") };
  }

  const shared = await checkSharedPreflight({
    workspacePath,
    spec: recipe.spec,
  });

  // Order: node, git, git-repo, recipe, agent, package-manager, recipe files,
  // prompts, optional deps / SMOKE, EVALUATE browser, chain env.
  const early = takeShared(shared, ["node", "git", "git-repo"]);
  const mid = takeSharedExcept(shared, ["node", "git", "git-repo", "evaluate-browser"]);
  const evaluate = takeShared(shared, ["evaluate-browser"]);

  checks.push(...early.map(toDoctorCheck));
  checks.push(recipe.check);
  checks.push(...mid.map(toDoctorCheck));
  checks.push(await checkPromptOverrides(recipe.spec.projectRoot));
  checks.push(...(await checkOptionalDeps(recipe.spec, workspacePath)));
  checks.push(...evaluate.map(toDoctorCheck));
  checks.push(...(await checkChainEnv(recipe.spec)));

  return { checks, passed: checks.every(check => check.status !== "fail") };
}

export function formatDoctorReport(report: DoctorReport): string {
  const symbol: Record<CheckStatus, string> = { ok: "✔", warn: "!", fail: "✘" };
  // Only the first line of a check carries its symbol, so any continuation —
  // in the detail or the fix — has to be indented to stay inside the report.
  const indent = (text: string) => text.split("\n").join("\n      ");
  const lines = report.checks.map(check => {
    const head = `  ${symbol[check.status]} ${check.name} — ${indent(check.detail)}`;
    return check.status === "ok" || !check.fix ? head : `${head}\n      ${indent(check.fix)}`;
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

/**
 * `detail` is already the doctor-facing rendering — `runDetail` carries the
 * run-oriented one. Doctor used to recover its short form by regexing the run
 * sentence, which meant rewording a message in preflight.ts silently degraded
 * this report with no test failing.
 */
function toDoctorCheck(verdict: PreflightVerdict): DoctorCheck {
  return {
    name: verdict.name,
    status: verdict.status,
    detail: verdict.detail,
    fix: verdict.fix,
  };
}

function takeShared(shared: PreflightVerdict[], ids: string[]): PreflightVerdict[] {
  const wanted = new Set(ids);
  return shared.filter(v => wanted.has(v.id));
}

function takeSharedExcept(shared: PreflightVerdict[], exclude: string[]): PreflightVerdict[] {
  const skip = new Set(exclude);
  return shared.filter(v => !skip.has(v.id));
}

async function loadRecipe(
  specPath: string,
): Promise<{
  check: DoctorCheck;
  spec?: TemplateSpec;
}> {
  try {
    const loaded = await loadTemplateSpec(specPath);
    return {
      spec: loaded.spec,
      check: {
        name: "recipe",
        status: loaded.warnings.length > 0 ? "warn" : "ok",
        detail:
          loaded.warnings.length > 0
            ? `${loaded.specPath} loads with ${loaded.warnings.length} warning(s)`
            : `${loaded.specPath} (schema v${loaded.spec.schemaVersion})`,
        fix: loaded.warnings.length > 0 ? loaded.warnings.join("\n      ") : undefined,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      check: {
        name: "recipe",
        status: "fail",
        detail,
        fix: "Fix the recipe, or bootstrap one with `hedera-harness init`.",
      },
    };
  }
}

/** Fallback host checks when the recipe cannot load (shared preflight needs a spec). */
function checkNodeVersionLocal(): DoctorCheck {
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

async function checkCommandLocal(
  command: string,
  cwd: string,
  why: string,
): Promise<DoctorCheck> {
  return (await commandExists(command, cwd))
    ? { name: command, status: "ok", detail: "on PATH" }
    : { name: command, status: "fail", detail: "not on PATH", fix: why };
}

async function checkGitRepoLocal(workspacePath: string): Promise<DoctorCheck> {
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

/**
 * Doctor-only host deps: bundled Playwright when SMOKE is on, bundled SDK when
 * CHAIN is on, and SMOKE browser when EVALUATE is off. EVALUATE browser probing
 * lives in shared preflight.
 */
async function checkOptionalDeps(spec: TemplateSpec, cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  let smokePlaywrightAvailable = false;
  if (spec.validators.playwrightPath) {
    const dependency = await checkHarnessPlaywright();
    checks.push(dependency);
    smokePlaywrightAvailable = dependency.status === "ok";
  }
  if (!isValidatorEnabled(spec) && smokePlaywrightAvailable) {
    checks.push(await checkSmokeBrowser(cwd));
  }
  if (spec.chainValidation?.enabled) {
    checks.push(await checkHarnessSdk());
  }
  return checks;
}

async function checkSmokeBrowser(projectRoot: string): Promise<DoctorCheck> {
  const { launchSharedBrowser, resolveMcpBrowser } = await import("./mcpBrowser.js");
  const choice = await resolveMcpBrowser(projectRoot);
  try {
    const browser = await launchSharedBrowser(projectRoot);
    await browser.close();
    return {
      name: "SMOKE browser",
      status: "ok",
      detail: choice.detail,
    };
  } catch (error) {
    return {
      name: "SMOKE browser",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix:
        choice.source === "project-playwright"
          ? "Reinstall Chromium: npx playwright install chromium"
          : "Install system Chrome, or install Chromium: npx playwright install chromium",
    };
  }
}

async function checkHarnessPlaywright(): Promise<DoctorCheck> {
  try {
    await import("playwright");
    return {
      name: "playwright",
      status: "ok",
      detail: "shipped with hedera-harness",
    };
  } catch (error) {
    return {
      name: "playwright",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Reinstall hedera-harness — SMOKE uses the Playwright API bundled with the CLI, not a project peer.",
    };
  }
}

async function checkHarnessSdk(): Promise<DoctorCheck> {
  try {
    await import("@hiero-ledger/sdk");
    return {
      name: "@hiero-ledger/sdk",
      status: "ok",
      detail: "shipped with hedera-harness",
    };
  } catch (error) {
    return {
      name: "@hiero-ledger/sdk",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Reinstall hedera-harness — CHAIN uses the SDK bundled with the CLI, not a project peer.",
    };
  }
}

async function checkChainEnv(spec: TemplateSpec): Promise<DoctorCheck[]> {
  const chain = spec.chainValidation;
  if (!chain?.enabled) return [];

  // On local there is nothing to authenticate against: what matters is whether
  // the three listeners are up. The node ships predefined funded accounts, so
  // the operator env vars are optional there.
  if (chain.network === "local") {
    const local = chain.local ?? DEFAULT_LOCAL_CHAIN;
    return Promise.all([
      checkJsonRpc("chain rpc", local.rpcUrl),
      checkMirror("chain mirror", local.mirrorUrl),
      checkPort("chain grpc", local.grpcUrl),
    ]);
  }

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

/** `eth_chainId` — an open port is not a chain, and a wrong port answers a TCP connect. */
async function checkJsonRpc(name: string, url: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { result?: string };
    if (typeof body.result !== "string") {
      return unreachable(name, url, "answered, but not with a chain id");
    }
    return { name, status: "ok", detail: `${url} chain id ${parseInt(body.result, 16)}` };
  } catch {
    return unreachable(name, url, "no JSON-RPC answer");
  }
}

/** The mirror's node list: present on a Hedera mirror, absent on anything else. */
async function checkMirror(name: string, url: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/api/v1/network/nodes`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await response.json()) as { nodes?: unknown[] };
    if (!Array.isArray(body.nodes)) {
      return unreachable(name, url, "answered, but not like a mirror node");
    }
    return { name, status: "ok", detail: `${url} ${body.nodes.length} node(s)` };
  } catch {
    return unreachable(name, url, "no mirror node answer");
  }
}

/** gRPC has no cheap unauthenticated probe, so this is a TCP connect and says so. */
async function checkPort(name: string, url: string): Promise<DoctorCheck> {
  const target = parseHostPort(url);
  if (!target) {
    return unreachable(name, url, "not host:port");
  }
  const open = await new Promise<boolean>(resolve => {
    const socket = connect({ host: target.host, port: target.port });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
  return open
    ? { name, status: "ok", detail: `${url} accepting connections (TCP only)` }
    : unreachable(name, url, "nothing listening");
}

function unreachable(name: string, url: string, detail: string): DoctorCheck {
  return {
    name,
    status: "fail",
    detail: `${url}: ${detail}`,
    fix: "Start a local Hedera node - hanvil, or hiero-local-node - before `run`.",
  };
}

/** `http://host:port`, `host:port`, and the ports each protocol defaults to. */
function parseHostPort(url: string): { host: string; port: number } | undefined {
  const withScheme = url.includes("://") ? url : `tcp://${url}`;
  try {
    const parsed = new URL(withScheme);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return parsed.hostname && Number.isInteger(port) ? { host: parsed.hostname, port } : undefined;
  } catch {
    return undefined;
  }
}
