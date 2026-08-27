import path from "node:path";
import { commandExists, readGitRepoSnapshot } from "./harnessGit.js";
import { loadTemplateSpec } from "./specLoader.js";
import { resolvePackageInstallTool } from "./optionalDeps.js";
import { isValidatorEnabled } from "./evaluation.js";
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
 * adds recipe load, prompt overrides, optional package imports, SMOKE browser
 * (when EVALUATE is off), and chain env.
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
  checks.push(...checkChainEnv(recipe.spec));

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

function toDoctorCheck(verdict: PreflightVerdict): DoctorCheck {
  return {
    name: verdict.name,
    status: verdict.status,
    detail: doctorDetail(verdict),
    fix: verdict.fix,
  };
}

/** Prefer short doctor-facing detail when the shared fail message is run-oriented. */
function doctorDetail(verdict: PreflightVerdict): string {
  if (verdict.status === "ok" || verdict.status === "warn") {
    return verdict.detail;
  }

  switch (verdict.id) {
    case "node":
      return `v${process.versions.node} is too old`;
    case "git":
      return "not on PATH";
    case "git-repo":
      if (verdict.runErrorCode === "detached-head") return "HEAD is detached";
      if (verdict.runErrorCode === "git-operation-in-progress") {
        const match = /git (\S+) is in progress/.exec(verdict.detail);
        return match ? `a ${match[1]} is in progress` : verdict.detail;
      }
      if (verdict.runErrorCode === "missing-branch" && verdict.detail.startsWith("Unable")) {
        return verdict.detail;
      }
      return verdict.detail;
    case "agent": {
      const match = /generator command "([^"]+)" on PATH/.exec(verdict.detail);
      return match ? `${match[1]} is not on PATH` : verdict.detail;
    }
    case "package-manager": {
      if (verdict.detail.includes("is not on PATH")) return verdict.detail;
      const match = /package manager "([^"]+)" on PATH/.exec(verdict.detail);
      return match ? `${match[1]} is not on PATH` : verdict.detail;
    }
    default:
      if (verdict.id.startsWith("recipe-file:")) {
        const match = /does not exist: (.+)$/.exec(verdict.detail);
        return match ? `missing: ${match[1]}` : verdict.detail;
      }
      return verdict.detail;
  }
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
 * Doctor-only optional deps: package imports and SMOKE browser when EVALUATE is off.
 * EVALUATE browser probing lives in shared preflight.
 */
async function checkOptionalDeps(spec: TemplateSpec, cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const tool = await resolvePackageInstallTool({
    projectRoot: cwd,
    packageManager: spec.constraints?.packageManager,
  });

  let smokePlaywrightAvailable = false;
  if (spec.validators.playwrightPath) {
    const dependency = await checkImport("playwright", "SMOKE Playwright gate", tool);
    checks.push(dependency);
    smokePlaywrightAvailable = dependency.status === "ok";
  }
  if (!isValidatorEnabled(spec) && smokePlaywrightAvailable) {
    checks.push(await checkSmokeBrowser(cwd));
  }
  if (spec.chainValidation?.enabled) {
    checks.push(await checkImport("@hiero-ledger/sdk", "CHAIN on-chain validation", tool));
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
