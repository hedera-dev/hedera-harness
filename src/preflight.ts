import { access } from "node:fs/promises";
import {
  commandExists,
  readGitRepoSnapshot,
  type GitRepoSnapshot,
} from "./harnessGit.js";
import { isValidatorEnabled } from "./evaluation.js";
import { resolvePackageInstallTool } from "./optionalDeps.js";
import { AGENT_PRESETS } from "./specDefaults.js";
import type { TemplateSpec } from "./types.js";
import { allEvalPaths, specHasEval } from "./sliceSelection.js";

export type PreflightStatus = "ok" | "warn" | "fail";

export interface PreflightVerdict {
  /** Stable machine id, e.g. "node", "git", "git-repo", "agent", "package-manager", "recipe-file:prd", "eval-config", "evaluate-browser" */
  id: string;
  /** Human label for doctor output */
  name: string;
  status: PreflightStatus;
  /**
   * Short, doctor-facing. One line: doctor indents only `fix`, so a newline here
   * would land unindented in the report.
   */
  detail: string;
  /**
   * The message `run` throws, when it differs from `detail`. Both renderings are
   * carried as data rather than recovered from each other — doctor used to regex
   * its short form out of the run sentence, which put the two surfaces one
   * reworded string away from drifting apart again.
   */
  runDetail?: string;
  fix?: string;
  /** SessionError.code when run throws on this failure */
  runErrorCode?: string;
}

export interface PreflightInput {
  workspacePath: string;
  spec: TemplateSpec;
  /** Optional; if omitted, read via readGitRepoSnapshot */
  gitSnapshot?: GitRepoSnapshot;
  /**
   * Rules to leave unevaluated. A skipped rule is never run, so callers do not
   * pay for its side effects — `run` skips the browser probe under
   * `skipToolChecks`, and skipping it must not still cost a browser launch.
   */
  skipIds?: ReadonlySet<string>;
  /** Called before a rule that can take seconds, so a silent wait is explained. */
  onProgress?: (message: string) => void;
}

/** The message `run` should throw for a verdict. */
export function runMessage(verdict: PreflightVerdict): string {
  return verdict.runDetail ?? verdict.detail;
}

/**
 * Shared rule list for `doctor` and `run` (session prepare).
 *
 * Yielded lazily: doctor drains the whole list to report everything, while run
 * stops at the first failure and never pays for the rules after it. The browser
 * probe is last and costs seconds — a minute when `@playwright/mcp` is cold —
 * which a run aborting on a missing PRD should not be charged for.
 */
export async function* iterSharedPreflight(
  input: PreflightInput,
): AsyncGenerator<PreflightVerdict> {
  const { workspacePath, spec } = input;
  const skip = input.skipIds ?? new Set<string>();

  if (!skip.has("node")) yield checkNodeVersion();
  if (!skip.has("git")) yield await checkGitOnPath(workspacePath);
  if (!skip.has("git-repo")) yield await checkGitRepo(workspacePath, input.gitSnapshot);
  if (!skip.has("agent")) yield await checkAgentCli(spec, workspacePath);
  if (!skip.has("package-manager")) yield await checkPackageManager(spec, workspacePath);

  for (const verdict of await checkRecipeFiles(spec)) {
    if (!skip.has(verdict.id)) yield verdict;
  }

  // `eval` is recipe configuration, not host tooling: it is checked even when
  // the browser probe below is skipped.
  if (isValidatorEnabled(spec)) {
    if (!specHasEval(spec)) {
      if (!skip.has("eval-config")) yield missingEvalConfig();
      return;
    }
    if (!skip.has("evaluate-browser")) {
      input.onProgress?.("checking the EVALUATE browser");
      yield await checkEvaluateBrowser(workspacePath);
    }
  }
}

/** Every verdict, for doctor's report. */
export async function checkSharedPreflight(
  input: PreflightInput,
): Promise<PreflightVerdict[]> {
  const verdicts: PreflightVerdict[] = [];
  for await (const verdict of iterSharedPreflight(input)) {
    verdicts.push(verdict);
  }
  return verdicts;
}

/**
 * Host-tooling verdict ids that `prepareSession({ skipToolChecks: true })` skips.
 * Git-repo, recipe-file and eval-config checks still apply — they are properties
 * of the repository and the recipe, not of the machine.
 */
export const SKIPPABLE_HOST_PREFLIGHT_IDS: ReadonlySet<string> = new Set([
  "node",
  "git",
  "agent",
  "package-manager",
  "evaluate-browser",
]);

function checkNodeVersion(): PreflightVerdict {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (Number.isFinite(major) && major >= 20) {
    return {
      id: "node",
      name: "node",
      status: "ok",
      detail: `v${process.versions.node}`,
    };
  }
  return {
    id: "node",
    name: "node",
    status: "fail",
    detail: `v${process.versions.node} is too old`,
    runDetail: `Harness run requires Node.js >= 20 (found ${process.versions.node}).`,
    fix: "The harness requires Node.js 20 or newer.",
    runErrorCode: "node-version",
  };
}

async function checkGitOnPath(cwd: string): Promise<PreflightVerdict> {
  if (await commandExists("git", cwd)) {
    return { id: "git", name: "git", status: "ok", detail: "on PATH" };
  }
  return {
    id: "git",
    name: "git",
    status: "fail",
    detail: "not on PATH",
    runDetail: "Harness run requires `git` on PATH.",
    fix: "git is required for branch and checkpoint handling.",
    runErrorCode: "missing-git",
  };
}

async function checkGitRepo(
  workspacePath: string,
  provided?: GitRepoSnapshot,
): Promise<PreflightVerdict> {
  try {
    const snapshot = provided ?? (await readGitRepoSnapshot(workspacePath));
    if (snapshot.detached) {
      return {
        id: "git-repo",
        name: "git repo",
        status: "fail",
        detail: "HEAD is detached",
        runDetail: "Harness run requires an attached HEAD (checkout a branch before running).",
        fix: "Check out a branch — the harness records its work on one.",
        runErrorCode: "detached-head",
      };
    }
    if (snapshot.inProgressOperation) {
      return {
        id: "git-repo",
        name: "git repo",
        status: "fail",
        detail: `a ${snapshot.inProgressOperation} is in progress`,
        runDetail: `Harness run refuses to run while a git ${snapshot.inProgressOperation} is in progress. Finish or abort it first.`,
        fix: "Finish or abort it first.",
        runErrorCode: "git-operation-in-progress",
      };
    }
    if (!snapshot.branch) {
      return {
        id: "git-repo",
        name: "git repo",
        status: "fail",
        detail: "Unable to determine the current git branch.",
        fix: "Check out a branch — the harness records its work on one.",
        runErrorCode: "missing-branch",
      };
    }
    return {
      id: "git-repo",
      name: "git repo",
      status: "ok",
      detail: `on ${snapshot.branch}`,
    };
  } catch (error) {
    return {
      id: "git-repo",
      name: "git repo",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      fix: "Run from inside a git repository (`hedera-harness init` creates one).",
      runErrorCode: "missing-branch",
    };
  }
}

async function checkAgentCli(spec: TemplateSpec, cwd: string): Promise<PreflightVerdict> {
  const command = spec.generator.command?.trim() || AGENT_PRESETS[spec.agent].command;
  const name = `agent (${spec.agent})`;

  // Absolute paths and npx-style wrappers are not resolvable via PATH.
  if (command.includes("/") || command.includes("\\")) {
    return {
      id: "agent",
      name,
      status: "ok",
      detail: `${command} (not checked)`,
    };
  }

  if (await commandExists(command, cwd)) {
    return {
      id: "agent",
      name,
      status: "ok",
      detail: `${command} on PATH`,
    };
  }

  return {
    id: "agent",
    name,
    status: "fail",
    detail: `${command} is not on PATH`,
    runDetail: `Harness run requires generator command ${JSON.stringify(command)} on PATH.`,
    fix: `Install and authenticate the ${spec.agent} CLI, or set a different \`agent:\` in the recipe.`,
    runErrorCode: "missing-agent",
  };
}

async function checkPackageManager(
  spec: TemplateSpec,
  cwd: string,
): Promise<PreflightVerdict> {
  const declared = spec.constraints?.packageManager?.trim();
  const binary = declared
    ? declared.split("@")[0] || declared
    : await resolvePackageInstallTool({ projectRoot: cwd });

  if (await commandExists(binary, cwd)) {
    return {
      id: "package-manager",
      name: "package manager",
      status: "ok",
      detail: `${binary} on PATH`,
    };
  }

  return {
    id: "package-manager",
    name: "package manager",
    status: "fail",
    detail: `${binary} is not on PATH`,
    runDetail: declared
      ? `Harness run requires package manager ${JSON.stringify(binary)} on PATH (from spec.constraints.packageManager).`
      : `Harness run requires package manager ${JSON.stringify(binary)} on PATH.`,
    fix: declared
      ? `The recipe declares constraints.packageManager: ${declared}.`
      : "Detected from the project's lockfile.",
    runErrorCode: "missing-package-manager",
  };
}

async function checkRecipeFiles(spec: TemplateSpec): Promise<PreflightVerdict[]> {
  const evalTargets = allEvalPaths(spec);
  const targets: Array<[string, string | undefined]> = [
    ...spec.prdPaths.map((prd, i): [string, string] => [
      spec.prdPaths.length > 1 ? `prd[${i}]` : "prd",
      prd,
    ]),
    ["validators.static", spec.validators.staticPath],
    ["validators.commands", spec.validators.commandsPath],
    ["validators.playwright", spec.validators.playwrightPath],
    ...evalTargets.map((evalPath, i): [string, string] => [
      evalTargets.length > 1 ? `eval[${i}]` : "eval",
      evalPath,
    ]),
  ];

  const verdicts: PreflightVerdict[] = [];
  for (const [label, target] of targets) {
    if (!target) continue;
    try {
      await access(target);
      verdicts.push({
        id: `recipe-file:${label}`,
        name: label,
        status: "ok",
        detail: "present",
      });
    } catch {
      verdicts.push({
        id: `recipe-file:${label}`,
        name: label,
        status: "fail",
        detail: `missing: ${target}`,
        runDetail: `Harness run preflight failed: required ${label} path does not exist: ${target}`,
        fix: "The recipe points at a file that does not exist.",
        runErrorCode: "missing-recipe-file",
      });
    }
  }
  return verdicts;
}

/**
 * EVALUATE is enabled but the recipe never says what to grade against.
 *
 * Reported as `eval`, not as a browser problem: no browser is involved, and
 * filing it under the probe's id would let `skipToolChecks` suppress a recipe
 * error and would leave it undrivable from a test that skips host tooling.
 */
function missingEvalConfig(): PreflightVerdict {
  return {
    id: "eval-config",
    name: "eval",
    status: "fail",
    detail: "`validator.enabled` is set but `eval` is not",
    runDetail: [
      "Harness run preflight failed: EVALUATE is enabled (`validator.enabled`) but `eval` is not set.",
      "Add `eval: .harness/eval.json`.",
      "Or disable EVALUATE by removing `validator.enabled`.",
    ].join("\n"),
    fix: "Add `eval: .harness/eval.json`, or remove `validator.enabled` to turn EVALUATE off.",
    runErrorCode: "missing-eval",
  };
}

/** Probe the MCP browser EVALUATE will drive. Costs seconds; runs last. */
async function checkEvaluateBrowser(cwd: string): Promise<PreflightVerdict> {
  const name = "EVALUATE browser (Playwright MCP)";

  const { probeMcpBrowser } = await import("./mcpBrowser.js");
  const probe = await probeMcpBrowser(cwd);

  if (probe.ok) {
    return {
      id: "evaluate-browser",
      name,
      status: "ok",
      detail: probe.choice.detail,
    };
  }

  const repair =
    probe.choice.source === "project-playwright"
      ? "npx playwright install chromium"
      : "Install Google Chrome, or run: npx playwright install chromium";

  return {
    id: "evaluate-browser",
    name,
    status: "fail",
    detail: probe.error ?? "the Playwright MCP browser could not be launched",
    runDetail: [
      "Harness run preflight failed: EVALUATE is enabled but the Playwright MCP browser could not be launched.",
      probe.error ?? "",
      `Fix: ${repair}`,
      "Or disable EVALUATE by removing `eval` / `validator.enabled` from the recipe.",
    ]
      .filter(Boolean)
      .join("\n  "),
    fix:
      probe.choice.source === "project-playwright"
        ? `Reinstall Chromium: ${repair}`
        : `Install system Chrome so SMOKE and EVALUATE share one browser: ${repair}`,
    runErrorCode: "missing-tier3-browser",
  };
}
