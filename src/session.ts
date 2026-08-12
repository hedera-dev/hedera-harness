import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logPhase } from "./attemptLoop.js";
import { decideBranchAction, isHarnessBranch, parseHarnessBranch } from "./branchDetection.js";
import { executeCommand } from "./command.js";
import {
  assertWorkingTreeCleanForRunStart,
  commandExists,
  createAndCheckoutHarnessBranch,
  filterRelevantDirtyEntries,
  readGitRepoSnapshot,
  resolveHeadSha,
  type GitRepoSnapshot,
} from "./harnessGit.js";
import {
  createSessionLayout,
  openRunLayout,
  type RunLayout,
  writeJsonFile,
} from "./runArtifacts.js";
import type { LoadedTemplateSpec } from "./specLoader.js";
import type { TemplateSpec } from "./types.js";

export const SESSION_SCHEMA_VERSION = 1;
export const SESSION_FILENAME = "session.json";

export type SessionMode = "start" | "continue";
export type GateStatus = "pending" | "passed" | "failed" | "aborted";

export interface BaselineResult {
  passed: boolean;
  commands: Array<{
    name: string;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
  }>;
}

export interface SessionMetadata {
  schemaVersion: number;
  sessionId: string;
  runDirectory: string;
  workspacePath: string;
  specPath: string;
  specSlug: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  repositoryRoot: string;
  startedAt: string;
  updatedAt: string;
  cycle: number;
  lastAttempt: number;
  lastCheckpointSha: string;
  gateStatus: GateStatus;
  baselineResult?: BaselineResult;
  /**
   * Increment the last cycle stopped on, zero-based. A `--continue` resumes here
   * rather than redoing increments already delivered. Absent means the first.
   */
  sliceIndex?: number;
  /**
   * Finding ids still failing when the last cycle stopped.
   *
   * Carried across `--continue` so the next cycle can report what it closed
   * rather than restarting the delta from zero. Optional: sessions written
   * before the findings lifecycle landed simply have no history.
   */
  openFindingIds?: string[];
}

export interface PrepareSessionInput {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  /** Optional override used by tests (skip host tool checks). */
  skipToolChecks?: boolean;
  /** Optional override used by tests (skip baseline commands). */
  skipBaseline?: boolean;
  /** Force a new harness branch even when current branch matches the spec. */
  forceNew?: boolean;
  /** Explicit harness branch to checkout and continue. */
  continueBranch?: string;
}

export interface PreparedSession {
  mode: SessionMode;
  layout: RunLayout;
  session: SessionMetadata;
  snapshot: GitRepoSnapshot;
  startingAttempt: number;
  cycle: number | undefined;
}

export class SessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

export function sessionFilePath(runDirectory: string): string {
  return path.join(runDirectory, SESSION_FILENAME);
}

export async function readSession(
  runDirectory: string,
): Promise<SessionMetadata | null> {
  try {
    const raw = await readFile(sessionFilePath(runDirectory), "utf8");
    const parsed = JSON.parse(raw) as SessionMetadata;
    if (parsed.schemaVersion !== SESSION_SCHEMA_VERSION) {
      return null;
    }
    if (typeof parsed.sessionId !== "string" || typeof parsed.branch !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeSession(session: SessionMetadata): Promise<void> {
  await mkdir(session.runDirectory, { recursive: true });
  await writeJsonFile(sessionFilePath(session.runDirectory), {
    ...session,
    updatedAt: new Date().toISOString(),
  });
}

export async function updateSession(
  runDirectory: string,
  patch: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const current = await readSession(runDirectory);
  if (!current) {
    throw new SessionError(
      "session-missing",
      `Cannot update harness session: missing ${sessionFilePath(runDirectory)}`,
    );
  }
  const next: SessionMetadata = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeSession(next);
  return next;
}

/**
 * Read-only preflight + smart branch classification + start/continue orchestration.
 *
 * - Same harness branch + same spec → continue
 * - Different spec (or normal branch) → new `harness/run-*` branch
 * - `--new` → always new branch
 * - `--continue <branch>` → checkout that branch and continue
 */
export async function prepareSession(
  input: PrepareSessionInput,
): Promise<PreparedSession> {
  const workspacePath = path.resolve(input.workspacePath);
  const { spec } = input.loaded;

  await assertPathExists(workspacePath, "workspace");
  await assertRecipeFilesExist(spec);

  if (input.forceNew && input.continueBranch) {
    throw new SessionError(
      "conflicting-flags",
      "Cannot pass both --new and --continue.",
    );
  }

  if (input.continueBranch?.trim()) {
    await checkoutContinueBranch(workspacePath, input.continueBranch.trim());
  }

  const snapshot = await readGitRepoSnapshot(workspacePath);
  await assertReadOnlyGitPreflight(snapshot);

  if (!input.skipToolChecks) {
    await assertHostTooling(workspacePath, spec);
  }

  const decision = decideBranchAction({
    currentBranch: snapshot.branch,
    specName: spec.name,
    forceNew: input.forceNew,
    continueBranch: input.continueBranch,
  });

  if (decision.action === "continue") {
    return continueSession({
      workspacePath,
      loaded: input.loaded,
      snapshot,
    });
  }

  // Different-spec on a harness branch: start a new branch from current HEAD
  // (accumulates prior feature work) after a clean-tree check.
  return startSession({
    workspacePath,
    loaded: input.loaded,
    snapshot,
    skipBaseline: input.skipBaseline,
  });
}

async function checkoutContinueBranch(workspacePath: string, branch: string): Promise<void> {
  if (!isHarnessBranch(branch)) {
    throw new SessionError(
      "invalid-continue-branch",
      [
        `--continue expects a harness branch (harness/run-* or legacy harness/extend-*).`,
        `Got ${JSON.stringify(branch)}.`,
      ].join(" "),
    );
  }

  const parsed = parseHarnessBranch(branch);
  if (!parsed) {
    throw new SessionError(
      "invalid-continue-branch",
      `Unable to parse harness branch name ${JSON.stringify(branch)}.`,
    );
  }

  await assertWorkingTreeCleanForRunStart(workspacePath);

  const result = await executeCommand({
    command: "git",
    args: ["checkout", branch],
    cwd: workspacePath,
  });
  if (result.exitCode !== 0) {
    throw new SessionError(
      "continue-checkout-failed",
      [
        `Failed to checkout continue branch ${JSON.stringify(branch)}.`,
        result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
      ].join("\n"),
    );
  }
}

async function startSession(input: {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  snapshot: GitRepoSnapshot;
  skipBaseline?: boolean;
}): Promise<PreparedSession> {
  const { workspacePath, loaded, snapshot } = input;
  const { spec, specPath } = loaded;

  if (!snapshot.branch) {
    throw new SessionError(
      "detached-or-unborn",
      "Harness run start requires an attached branch name (not detached HEAD).",
    );
  }

  await assertWorkingTreeCleanForRunStart(workspacePath);

  const baseBranch = snapshot.branch;
  const baseSha = snapshot.headSha;
  logPhase("Creating harness branch", `from ${baseBranch}`);
  const created = await createAndCheckoutHarnessBranch(workspacePath, spec.name);
  logPhase("Harness branch ready", created.branch);
  const layout = await createSessionLayout(workspacePath, spec.name, resolveSessionLogging(spec));
  logPhase("Run artifacts directory", layout.runDirectory);

  const startedAt = new Date().toISOString();
  let session: SessionMetadata = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: path.basename(layout.runDirectory),
    runDirectory: layout.runDirectory,
    workspacePath,
    specPath,
    specSlug: spec.name,
    branch: created.branch,
    baseBranch,
    baseSha,
    repositoryRoot: snapshot.repositoryRoot,
    startedAt,
    updatedAt: startedAt,
    cycle: 0,
    lastAttempt: 0,
    lastCheckpointSha: created.headSha,
    gateStatus: "pending",
  };

  if (!input.skipBaseline) {
    logPhase("Running host baseline health checks", workspacePath);
    const baselineResult = await runBaseline(workspacePath, spec);
    session = {
      ...session,
      baselineResult,
      updatedAt: new Date().toISOString(),
    };
    if (!baselineResult.passed) {
      await writeSession(session);
      throw new SessionError(
        "baseline-failed",
        [
          "Harness baseline health commands failed before generation.",
          "These check the existing app (not the run acceptance gates).",
          ...baselineResult.commands
            .filter(command => command.exitCode !== 0)
            .map(
              command =>
                `- ${command.name}: exit ${command.exitCode ?? "null"} (${command.command})`,
            ),
        ].join("\n"),
      );
    }
  }

  await writeSession(session);

  return {
    mode: "start",
    layout,
    session,
    snapshot: await readGitRepoSnapshot(workspacePath),
    startingAttempt: 1,
    cycle: undefined,
  };
}

async function continueSession(input: {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  snapshot: GitRepoSnapshot;
}): Promise<PreparedSession> {
  const { workspacePath, loaded, snapshot } = input;
  const { spec, specPath } = loaded;
  const branch = snapshot.branch!;

  const session = await findMatchingSession({
    workspacePath,
    branch,
    specSlug: spec.name,
    specPath,
    repositoryRoot: snapshot.repositoryRoot,
  });

  if (!session) {
    throw new SessionError(
      "unknown-harness-branch",
      [
        `Current branch ${JSON.stringify(branch)} looks like a harness run branch,`,
        "but no matching local session metadata was found under .harness/runs/*/session.json.",
        "Refuse to create a nested branch. Use --new from a clean tree to start a fresh run,",
        "checkout a normal branch, or restore the matching session metadata before continuing.",
      ].join(" "),
    );
  }

  const relevantDirty = filterRelevantDirtyEntries(snapshot.entries);
  if (relevantDirty.length > 0) {
    throw new SessionError(
      "interrupted-dirty",
      formatInterruptedDirtyRecovery({
        branch,
        session,
        dirty: relevantDirty.map(entry => `${entry.code} ${entry.path}`),
        headSha: snapshot.headSha,
      }),
    );
  }

  if (snapshot.headSha !== session.lastCheckpointSha) {
    throw new SessionError(
      "checkpoint-mismatch",
      [
        "Harness continue refused: HEAD does not match the session lastCheckpointSha.",
        `HEAD=${snapshot.headSha}`,
        `lastCheckpointSha=${session.lastCheckpointSha}`,
        "If you intentionally added commits, update or abandon the session before re-running.",
        `Session: ${sessionFilePath(session.runDirectory)}`,
      ].join("\n"),
    );
  }

  const layout = await openRunLayout(session.runDirectory, resolveSessionLogging(spec));
  if (layout.mode !== "in-place-run") {
    throw new SessionError(
      "layout-mismatch",
      `Expected in-place-run layout at ${layout.runDirectory}, got ${layout.mode}`,
    );
  }

  const cycle = session.cycle + 1;
  const startingAttempt = session.lastAttempt + 1;
  const updated = await updateSession(session.runDirectory, {
    cycle,
    specPath,
    gateStatus: "pending",
  });

  return {
    mode: "continue",
    layout,
    session: updated,
    snapshot,
    startingAttempt,
    cycle,
  };
}

export async function findMatchingSession(input: {
  workspacePath: string;
  branch: string;
  specSlug: string;
  specPath: string;
  repositoryRoot: string;
}): Promise<SessionMetadata | null> {
  const runsRoot = path.join(input.workspacePath, ".harness", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }

  const matches: SessionMetadata[] = [];
  for (const entry of entries) {
    const runDirectory = path.join(runsRoot, entry);
    const session = await readSession(runDirectory);
    if (!session) continue;
    if (session.branch !== input.branch) continue;
    if (session.specSlug !== input.specSlug) continue;
    if (path.resolve(session.repositoryRoot) !== path.resolve(input.repositoryRoot)) continue;
    if (path.resolve(session.workspacePath) !== path.resolve(input.workspacePath)) continue;
    // Spec path may move; require same slug + branch + repo. Prefer exact path when present.
    if (
      path.resolve(session.specPath) !== path.resolve(input.specPath) &&
      path.basename(session.specPath) !== path.basename(input.specPath)
    ) {
      continue;
    }
    matches.push(session);
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return matches[0];
}

async function assertReadOnlyGitPreflight(snapshot: GitRepoSnapshot): Promise<void> {
  if (snapshot.detached) {
    throw new SessionError(
      "detached-head",
      "Harness run requires an attached HEAD (checkout a branch before running).",
    );
  }
  if (snapshot.inProgressOperation) {
    throw new SessionError(
      "git-operation-in-progress",
      `Harness run refuses to run while a git ${snapshot.inProgressOperation} is in progress. Finish or abort it first.`,
    );
  }
  if (!snapshot.branch) {
    throw new SessionError(
      "missing-branch",
      "Unable to determine the current git branch.",
    );
  }
}

async function assertHostTooling(cwd: string, spec: TemplateSpec): Promise<void> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    throw new SessionError(
      "node-version",
      `Harness run requires Node.js >= 20 (found ${process.versions.node}).`,
    );
  }

  if (!(await commandExists("git", cwd))) {
    throw new SessionError("missing-git", "Harness run requires `git` on PATH.");
  }

  const agentCommand = spec.generator.command?.trim() || "agent";
  // Only enforce PATH presence for bare commands (not absolute paths / npx wrappers).
  if (!agentCommand.includes("/") && !agentCommand.includes("\\")) {
    if (!(await commandExists(agentCommand, cwd))) {
      throw new SessionError(
        "missing-agent",
        `Harness run requires generator command ${JSON.stringify(agentCommand)} on PATH.`,
      );
    }
  }

  const packageManager = spec.constraints?.packageManager?.trim();
  if (packageManager) {
    const binary = packageManager.split("@")[0] || packageManager;
    if (!(await commandExists(binary, cwd))) {
      throw new SessionError(
        "missing-package-manager",
        `Harness run requires package manager ${JSON.stringify(binary)} on PATH (from spec.constraints.packageManager).`,
      );
    }
  }
}

async function assertRecipeFilesExist(spec: TemplateSpec): Promise<void> {
  const required: Array<[string, string]> = [
    ...spec.prdPaths.map(
      (prdPath, index): [string, string] => [
        spec.prdPaths.length > 1 ? `prd[${index}]` : "prd",
        prdPath,
      ],
    ),
    ["validators.static", spec.validators.staticPath],
    ["validators.commands", spec.validators.commandsPath],
  ];

  for (const [label, filePath] of required) {
    await assertPathExists(filePath, label);
  }
  if (spec.contractPath) {
    await assertPathExists(spec.contractPath, "contract");
  }
  if (spec.validators.playwrightPath) {
    await assertPathExists(spec.validators.playwrightPath, "validators.playwright");
  }
}

async function assertPathExists(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new SessionError(
      "missing-recipe-file",
      `Harness run preflight failed: required ${label} path does not exist: ${filePath}`,
    );
  }
}

async function runBaseline(
  workspacePath: string,
  spec: TemplateSpec,
): Promise<BaselineResult> {
  const commands = spec.baseline?.commands ?? [];
  if (commands.length === 0) {
    return { passed: true, commands: [] };
  }

  const results: BaselineResult["commands"] = [];
  for (const commandConfig of commands) {
    const name = commandConfig.name?.trim() || commandConfig.command;
    logPhase("Baseline command", name);
    const result = await executeCommand({
      command: commandConfig.command,
      cwd: workspacePath,
      timeoutMs: commandConfig.timeoutMs,
      shell: true,
      streamOutput: true,
    });
    results.push({
      name,
      command: commandConfig.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });
    logPhase(
      "Baseline command finished",
      `${name} exit=${result.exitCode} durationMs=${result.durationMs}`,
    );
    if (result.exitCode !== 0) {
      return { passed: false, commands: results };
    }
  }
  return { passed: true, commands: results };
}

function resolveSessionLogging(spec: TemplateSpec): { jsonlPath: string; notesPath: string } {
  return {
    jsonlPath: spec.logging.jsonlPath,
    notesPath: spec.logging.notesPath,
  };
}

function formatInterruptedDirtyRecovery(input: {
  branch: string;
  session: SessionMetadata;
  dirty: string[];
  headSha: string;
}): string {
  const preview = input.dirty.slice(0, 20).join("\n");
  const more = input.dirty.length > 20 ? `\n...and ${input.dirty.length - 20} more` : "";
  return [
    "Harness session interrupted with uncommitted consumer changes.",
    `Branch: ${input.branch}`,
    `HEAD: ${input.headSha}`,
    `Last checkpoint: ${input.session.lastCheckpointSha}`,
    `Session: ${sessionFilePath(input.session.runDirectory)}`,
    "",
    "The harness will not auto-commit potentially user-authored changes.",
    "Recover manually, then re-run on this branch:",
    "  git status",
    "  git diff",
    "  # discard unintended files, or commit intentional work",
    "  # then: hedera-harness run <spec>",
    "",
    "Dirty paths:",
    preview + more,
  ].join("\n");
}

/** Test helper: record checkpoint SHA / attempt counters after an attempt. */
export async function recordCheckpoint(input: {
  runDirectory: string;
  attempt: number;
  checkpointSha: string;
  gateStatus?: GateStatus;
}): Promise<SessionMetadata> {
  return updateSession(input.runDirectory, {
    lastAttempt: input.attempt,
    lastCheckpointSha: input.checkpointSha,
    ...(input.gateStatus ? { gateStatus: input.gateStatus } : {}),
  });
}

export async function resolveHeadShaOrThrow(cwd: string): Promise<string> {
  return resolveHeadSha(cwd);
}
