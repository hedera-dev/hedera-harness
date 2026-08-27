import { access } from "node:fs/promises";
import {
  commandExists,
  readGitRepoSnapshot,
  type GitRepoSnapshot,
} from "./harnessGit.js";
import { isValidatorEnabled } from "./evaluation.js";
import {
  buildOptionalDepInstallLines,
  resolvePackageInstallTool,
} from "./optionalDeps.js";
import { AGENT_PRESETS } from "./specDefaults.js";
import type { TemplateSpec } from "./types.js";

export type PreflightStatus = "ok" | "warn" | "fail";

export interface PreflightVerdict {
  /** Stable machine id, e.g. "node", "git", "git-repo", "agent", "package-manager", "recipe-file:prd", "evaluate-browser" */
  id: string;
  /** Human label for doctor output */
  name: string;
  status: PreflightStatus;
  detail: string;
  fix?: string;
  /** SessionError.code when run throws on this failure */
  runErrorCode?: string;
}

/**
 * Shared rule list for `doctor` and `run` (session prepare).
 *
 * Both surfaces must agree on these checks; doctor renders them as a report,
 * run throws SessionError on the first fail.
 */
export async function checkSharedPreflight(input: {
  workspacePath: string;
  spec: TemplateSpec;
  /** Optional; if omitted, read via readGitRepoSnapshot */
  gitSnapshot?: GitRepoSnapshot;
}): Promise<PreflightVerdict[]> {
  const { workspacePath, spec } = input;
  const verdicts: PreflightVerdict[] = [];

  verdicts.push(checkNodeVersion());
  verdicts.push(await checkGitOnPath(workspacePath));
  verdicts.push(await checkGitRepo(workspacePath, input.gitSnapshot));
  verdicts.push(await checkAgentCli(spec, workspacePath));
  verdicts.push(await checkPackageManager(spec, workspacePath));
  verdicts.push(...(await checkRecipeFiles(spec)));
  verdicts.push(...(await checkEvaluateBrowser(spec, workspacePath)));

  return verdicts;
}

/**
 * Host-tooling verdict ids that `prepareSession({ skipToolChecks: true })` skips.
 * Git-repo and recipe-file checks still apply.
 */
export const SKIPPABLE_HOST_PREFLIGHT_IDS = new Set([
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
    detail: `Harness run requires Node.js >= 20 (found ${process.versions.node}).`,
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
    detail: "Harness run requires `git` on PATH.",
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
        detail: "Harness run requires an attached HEAD (checkout a branch before running).",
        fix: "Check out a branch — the harness records its work on one.",
        runErrorCode: "detached-head",
      };
    }
    if (snapshot.inProgressOperation) {
      return {
        id: "git-repo",
        name: "git repo",
        status: "fail",
        detail: `Harness run refuses to run while a git ${snapshot.inProgressOperation} is in progress. Finish or abort it first.`,
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
    detail: `Harness run requires generator command ${JSON.stringify(command)} on PATH.`,
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
    detail: declared
      ? `Harness run requires package manager ${JSON.stringify(binary)} on PATH (from spec.constraints.packageManager).`
      : `${binary} is not on PATH`,
    fix: declared
      ? `The recipe declares constraints.packageManager: ${declared}.`
      : "Detected from the project's lockfile.",
    runErrorCode: "missing-package-manager",
  };
}

async function checkRecipeFiles(spec: TemplateSpec): Promise<PreflightVerdict[]> {
  const targets: Array<[string, string | undefined]> = [
    ...spec.prdPaths.map((prd, i): [string, string] => [
      spec.prdPaths.length > 1 ? `prd[${i}]` : "prd",
      prd,
    ]),
    ["validators.static", spec.validators.staticPath],
    ["validators.commands", spec.validators.commandsPath],
    ["validators.playwright", spec.validators.playwrightPath],
    ["eval", spec.evalPath],
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
        detail: `Harness run preflight failed: required ${label} path does not exist: ${target}`,
        fix: "The recipe points at a file that does not exist.",
        runErrorCode: "missing-recipe-file",
      });
    }
  }
  return verdicts;
}

/**
 * EVALUATE prerequisites: eval path when enabled, then a real MCP browser probe.
 */
async function checkEvaluateBrowser(
  spec: TemplateSpec,
  cwd: string,
): Promise<PreflightVerdict[]> {
  if (!isValidatorEnabled(spec)) {
    return [];
  }

  const name = "EVALUATE browser (Playwright MCP)";

  if (!spec.evalPath) {
    return [
      {
        id: "evaluate-browser",
        name,
        status: "fail",
        detail: [
          "Harness run preflight failed: EVALUATE is enabled (`validator.enabled`) but `eval` is not set.",
          "Add `eval: .harness/eval.json`.",
          "Or disable EVALUATE by removing `validator.enabled`.",
        ].join("\n"),
        runErrorCode: "missing-eval",
      },
    ];
  }

  const installTool = await resolvePackageInstallTool({
    projectRoot: cwd,
    packageManager: spec.constraints?.packageManager,
  });
  const installCmd = buildOptionalDepInstallLines("playwright", installTool)[0];

  const { probeMcpBrowser } = await import("./mcpBrowser.js");
  const probe = await probeMcpBrowser(cwd);

  if (probe.ok) {
    return [
      {
        id: "evaluate-browser",
        name,
        status: "ok",
        detail: probe.choice.detail,
      },
    ];
  }

  const fix =
    probe.choice.source === "project-playwright"
      ? "Reinstall the project's browser: npx playwright install chromium"
      : `Install Playwright in the project so SMOKE and EVALUATE share one browser: ${installCmd} && npx playwright install chromium`;

  return [
    {
      id: "evaluate-browser",
      name,
      status: "fail",
      detail: [
        "Harness run preflight failed: EVALUATE is enabled but the Playwright MCP browser could not be launched.",
        probe.error ?? "the Playwright MCP browser could not be launched",
        `Fix: ${
          probe.choice.source === "project-playwright"
            ? "npx playwright install chromium"
            : `${installCmd} && npx playwright install chromium`
        }`,
        "Or disable EVALUATE by removing `eval` / `validator.enabled` from the recipe.",
      ]
        .filter(Boolean)
        .join("\n  "),
      fix,
      runErrorCode: "missing-tier3-browser",
    },
  ];
}
