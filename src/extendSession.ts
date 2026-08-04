import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeCommand } from "./command.js";
import {
  assertWorkingTreeCleanForExtendStart,
  commandExists,
  createAndCheckoutExtendBranch,
  filterRelevantDirtyEntries,
  isHarnessExtendBranch,
  readGitRepoSnapshot,
  resolveHeadSha,
  type GitRepoSnapshot,
} from "./extendGit.js";
import {
  createExtendLayout,
  openRunLayout,
  type RunLayout,
  writeJsonFile,
} from "./runArtifacts.js";
import type { LoadedTemplateSpec } from "./specLoader.js";
import type { TemplateSpec } from "./types.js";

export const EXTEND_SESSION_SCHEMA_VERSION = 1;
export const EXTEND_SESSION_FILENAME = "session.json";

export type ExtendSessionMode = "start" | "continue";
export type ExtendGateStatus = "pending" | "passed" | "failed" | "aborted";

export interface ExtendBaselineResult {
  passed: boolean;
  commands: Array<{
    name: string;
    command: string;
    exitCode: number | null;
    durationMs: number;
    timedOut: boolean;
  }>;
}

export interface ExtendSessionMetadata {
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
  gateStatus: ExtendGateStatus;
  baselineResult?: ExtendBaselineResult;
}

export interface PrepareExtendSessionInput {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  /** Optional override used by tests (skip host tool checks). */
  skipToolChecks?: boolean;
  /** Optional override used by tests (skip baseline commands). */
  skipBaseline?: boolean;
}

export interface PreparedExtendSession {
  mode: ExtendSessionMode;
  layout: RunLayout;
  session: ExtendSessionMetadata;
  snapshot: GitRepoSnapshot;
  startingAttempt: number;
  cycle: number | undefined;
}

export class ExtendSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExtendSessionError";
    this.code = code;
  }
}

export function sessionFilePath(runDirectory: string): string {
  return path.join(runDirectory, EXTEND_SESSION_FILENAME);
}

export async function readExtendSession(
  runDirectory: string,
): Promise<ExtendSessionMetadata | null> {
  try {
    const raw = await readFile(sessionFilePath(runDirectory), "utf8");
    const parsed = JSON.parse(raw) as ExtendSessionMetadata;
    if (parsed.schemaVersion !== EXTEND_SESSION_SCHEMA_VERSION) {
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

export async function writeExtendSession(session: ExtendSessionMetadata): Promise<void> {
  await mkdir(session.runDirectory, { recursive: true });
  await writeJsonFile(sessionFilePath(session.runDirectory), {
    ...session,
    updatedAt: new Date().toISOString(),
  });
}

export async function updateExtendSession(
  runDirectory: string,
  patch: Partial<ExtendSessionMetadata>,
): Promise<ExtendSessionMetadata> {
  const current = await readExtendSession(runDirectory);
  if (!current) {
    throw new ExtendSessionError(
      "session-missing",
      `Cannot update extend session: missing ${sessionFilePath(runDirectory)}`,
    );
  }
  const next: ExtendSessionMetadata = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeExtendSession(next);
  return next;
}

/**
 * Read-only preflight + branch/session classification + start/continue orchestration.
 * Mutates git only after classification decides a clean normal-branch start.
 */
export async function prepareExtendSession(
  input: PrepareExtendSessionInput,
): Promise<PreparedExtendSession> {
  const workspacePath = path.resolve(input.workspacePath);
  const { spec, specPath } = input.loaded;

  await assertPathExists(workspacePath, "workspace");
  await assertRecipeFilesExist(spec);

  const snapshot = await readGitRepoSnapshot(workspacePath);
  await assertReadOnlyGitPreflight(snapshot);

  if (!input.skipToolChecks) {
    await assertHostTooling(workspacePath, spec);
  }

  if (isHarnessExtendBranch(snapshot.branch)) {
    return continueExtendSession({
      workspacePath,
      loaded: input.loaded,
      snapshot,
    });
  }

  return startExtendSession({
    workspacePath,
    loaded: input.loaded,
    snapshot,
    skipBaseline: input.skipBaseline,
  });
}

async function startExtendSession(input: {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  snapshot: GitRepoSnapshot;
  skipBaseline?: boolean;
}): Promise<PreparedExtendSession> {
  const { workspacePath, loaded, snapshot } = input;
  const { spec, specPath } = loaded;

  if (!snapshot.branch) {
    throw new ExtendSessionError(
      "detached-or-unborn",
      "Extend start requires an attached branch name (not detached HEAD).",
    );
  }

  await assertWorkingTreeCleanForExtendStart(workspacePath);

  const baseBranch = snapshot.branch;
  const baseSha = snapshot.headSha;
  const created = await createAndCheckoutExtendBranch(workspacePath, spec.name);
  const layout = await createExtendLayout(workspacePath, spec.name, resolveExtendLogging(spec));

  const startedAt = new Date().toISOString();
  let session: ExtendSessionMetadata = {
    schemaVersion: EXTEND_SESSION_SCHEMA_VERSION,
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
    const baselineResult = await runExtendBaseline(workspacePath, spec);
    session = {
      ...session,
      baselineResult,
      updatedAt: new Date().toISOString(),
    };
    if (!baselineResult.passed) {
      await writeExtendSession(session);
      throw new ExtendSessionError(
        "baseline-failed",
        [
          "Extend baseline health commands failed before generation.",
          "These check the existing app (not the extension acceptance gates).",
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

  await writeExtendSession(session);

  return {
    mode: "start",
    layout,
    session,
    snapshot: await readGitRepoSnapshot(workspacePath),
    startingAttempt: 1,
    cycle: undefined,
  };
}

async function continueExtendSession(input: {
  workspacePath: string;
  loaded: LoadedTemplateSpec;
  snapshot: GitRepoSnapshot;
}): Promise<PreparedExtendSession> {
  const { workspacePath, loaded, snapshot } = input;
  const { spec, specPath } = loaded;
  const branch = snapshot.branch!;

  const session = await findMatchingExtendSession({
    workspacePath,
    branch,
    specSlug: spec.name,
    specPath,
    repositoryRoot: snapshot.repositoryRoot,
  });

  if (!session) {
    throw new ExtendSessionError(
      "unknown-harness-branch",
      [
        `Current branch ${JSON.stringify(branch)} looks like a harness extend branch,`,
        "but no matching local session metadata was found under .harness/runs/*/session.json.",
        "Refuse to create a nested branch. Checkout a normal branch to start a new extension,",
        "or restore the matching session metadata before continuing.",
      ].join(" "),
    );
  }

  const relevantDirty = filterRelevantDirtyEntries(snapshot.entries);
  if (relevantDirty.length > 0) {
    throw new ExtendSessionError(
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
    throw new ExtendSessionError(
      "checkpoint-mismatch",
      [
        "Extend continue refused: HEAD does not match the session lastCheckpointSha.",
        `HEAD=${snapshot.headSha}`,
        `lastCheckpointSha=${session.lastCheckpointSha}`,
        "If you intentionally added commits, update or abandon the session before re-running.",
        `Session: ${sessionFilePath(session.runDirectory)}`,
      ].join("\n"),
    );
  }

  const layout = await openRunLayout(session.runDirectory, resolveExtendLogging(spec));
  if (layout.mode !== "in-place-extend") {
    throw new ExtendSessionError(
      "layout-mismatch",
      `Expected in-place-extend layout at ${layout.runDirectory}, got ${layout.mode}`,
    );
  }

  const cycle = session.cycle + 1;
  const startingAttempt = session.lastAttempt + 1;
  const updated = await updateExtendSession(session.runDirectory, {
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

export async function findMatchingExtendSession(input: {
  workspacePath: string;
  branch: string;
  specSlug: string;
  specPath: string;
  repositoryRoot: string;
}): Promise<ExtendSessionMetadata | null> {
  const runsRoot = path.join(input.workspacePath, ".harness", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }

  const matches: ExtendSessionMetadata[] = [];
  for (const entry of entries) {
    const runDirectory = path.join(runsRoot, entry);
    const session = await readExtendSession(runDirectory);
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
    throw new ExtendSessionError(
      "detached-head",
      "Extend requires an attached HEAD (checkout a branch before running).",
    );
  }
  if (snapshot.inProgressOperation) {
    throw new ExtendSessionError(
      "git-operation-in-progress",
      `Extend refuses to run while a git ${snapshot.inProgressOperation} is in progress. Finish or abort it first.`,
    );
  }
  if (!snapshot.branch) {
    throw new ExtendSessionError(
      "missing-branch",
      "Unable to determine the current git branch.",
    );
  }
}

async function assertHostTooling(cwd: string, spec: TemplateSpec): Promise<void> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    throw new ExtendSessionError(
      "node-version",
      `Extend requires Node.js >= 20 (found ${process.versions.node}).`,
    );
  }

  if (!(await commandExists("git", cwd))) {
    throw new ExtendSessionError("missing-git", "Extend requires `git` on PATH.");
  }

  const agentCommand = spec.generator.command?.trim() || "agent";
  // Only enforce PATH presence for bare commands (not absolute paths / npx wrappers).
  if (!agentCommand.includes("/") && !agentCommand.includes("\\")) {
    if (!(await commandExists(agentCommand, cwd))) {
      throw new ExtendSessionError(
        "missing-agent",
        `Extend requires generator command ${JSON.stringify(agentCommand)} on PATH.`,
      );
    }
  }

  const packageManager = spec.constraints?.packageManager?.trim();
  if (packageManager) {
    const binary = packageManager.split("@")[0] || packageManager;
    if (!(await commandExists(binary, cwd))) {
      throw new ExtendSessionError(
        "missing-package-manager",
        `Extend requires package manager ${JSON.stringify(binary)} on PATH (from spec.constraints.packageManager).`,
      );
    }
  }
}

async function assertRecipeFilesExist(spec: TemplateSpec): Promise<void> {
  const required = [
    ["prd", spec.prdPath],
    ["validators.static", spec.validators.staticPath],
    ["validators.commands", spec.validators.commandsPath],
  ] as const;

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
    throw new ExtendSessionError(
      "missing-recipe-file",
      `Extend preflight failed: required ${label} path does not exist: ${filePath}`,
    );
  }
}

async function runExtendBaseline(
  workspacePath: string,
  spec: TemplateSpec,
): Promise<ExtendBaselineResult> {
  const commands = spec.extend?.baseline?.commands ?? [];
  if (commands.length === 0) {
    return { passed: true, commands: [] };
  }

  const results: ExtendBaselineResult["commands"] = [];
  for (const commandConfig of commands) {
    const name = commandConfig.name?.trim() || commandConfig.command;
    const result = await executeCommand({
      command: commandConfig.command,
      cwd: workspacePath,
      timeoutMs: commandConfig.timeoutMs,
      shell: true,
    });
    results.push({
      name,
      command: commandConfig.command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
    });
    if (result.exitCode !== 0) {
      return { passed: false, commands: results };
    }
  }
  return { passed: true, commands: results };
}

function resolveExtendLogging(spec: TemplateSpec): { jsonlPath: string; notesPath: string } {
  return {
    jsonlPath: spec.logging.jsonlPath,
    notesPath: spec.logging.notesPath,
  };
}

function formatInterruptedDirtyRecovery(input: {
  branch: string;
  session: ExtendSessionMetadata;
  dirty: string[];
  headSha: string;
}): string {
  const preview = input.dirty.slice(0, 20).join("\n");
  const more = input.dirty.length > 20 ? `\n...and ${input.dirty.length - 20} more` : "";
  return [
    "Extend session interrupted with uncommitted consumer changes.",
    `Branch: ${input.branch}`,
    `HEAD: ${input.headSha}`,
    `Last checkpoint: ${input.session.lastCheckpointSha}`,
    `Session: ${sessionFilePath(input.session.runDirectory)}`,
    "",
    "The harness will not auto-commit potentially user-authored changes.",
    "Recover manually, then re-run extend on this branch:",
    "  git status",
    "  git diff",
    "  # discard unintended files, or commit intentional work",
    "  # then: hedera-harness extend <spec>",
    "",
    "Dirty paths:",
    preview + more,
  ].join("\n");
}

/** Test helper: record checkpoint SHA / attempt counters after an attempt. */
export async function recordExtendCheckpoint(input: {
  runDirectory: string;
  attempt: number;
  checkpointSha: string;
  gateStatus?: ExtendGateStatus;
}): Promise<ExtendSessionMetadata> {
  return updateExtendSession(input.runDirectory, {
    lastAttempt: input.attempt,
    lastCheckpointSha: input.checkpointSha,
    ...(input.gateStatus ? { gateStatus: input.gateStatus } : {}),
  });
}

export async function resolveHeadShaOrThrow(cwd: string): Promise<string> {
  return resolveHeadSha(cwd);
}
