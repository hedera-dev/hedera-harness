import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { readLayoutMeta } from "./runArtifacts.js";
import { readGitRepoSnapshot } from "./harnessGit.js";
import { loadTemplateSpec } from "./specLoader.js";
import type { CliOptions, RunReport } from "./types.js";

/**
 * Read what a run is doing right now.
 *
 * The loop has always written `status.json` on every phase change and on a
 * 15-second heartbeat while the agent works, but nothing read it back: a run
 * takes 40 minutes to two hours, and the only way to watch one was to stare at
 * the terminal that launched it. This is the reader.
 *
 * Everything here is read-only on purpose. `resolveArtifactDirsForWorkspace`
 * creates directories as a side effect, which is fine for a run that is about
 * to write into them and wrong for a command that only reports.
 */

/** Phases the run loop writes. A `_running` phase means an agent is live. */
const RUNNING_PHASES = new Set(["generator_running", "repair_running"]);

/**
 * How long a `_running` status may go unwritten before it is suspect.
 *
 * The generator heartbeat writes every 15 seconds, so a gap much larger than
 * that means the process is gone — a killed terminal, a crash, a reboot —
 * rather than an agent thinking hard.
 */
const STALE_AFTER_SECONDS = 90;

export interface RunStatusSnapshot {
  workspacePath: string;
  specPath: string;
  specName?: string;
  branch?: string;
  /** Newest run directory belonging to this workspace, or null when there is none. */
  runDirectory: string | null;
  /** Parsed `status.json`. Null when the run directory has not written one. */
  status: Record<string, unknown> | null;
  /** Parsed `reports/report.json`, present once a run has finished. */
  report: RunReport | null;
  /** Seconds since `status.json` was last written. */
  ageSeconds?: number;
  /** True when a `_running` phase has gone quiet for longer than the heartbeat. */
  stale: boolean;
}

export async function readRunStatus(options: CliOptions): Promise<RunStatusSnapshot> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  const runDirectory = await findNewestRunDirectory(workspacePath);

  const snapshot: RunStatusSnapshot = {
    workspacePath,
    specPath: options.specPath,
    runDirectory,
    status: null,
    report: null,
    stale: false,
  };

  // Best-effort context. A recipe that no longer parses, or a workspace that is
  // not a git repo, must not stop the command from reporting the run itself.
  snapshot.specName = await readSpecName(options.specPath);
  snapshot.branch = await readBranch(workspacePath);

  if (!runDirectory) return snapshot;

  snapshot.status = await readJsonFile<Record<string, unknown>>(
    path.join(runDirectory, "status.json"),
  );
  snapshot.report = await readJsonFile<RunReport>(
    path.join(runDirectory, "reports", "report.json"),
  );

  const updatedAt = readString(snapshot.status?.updatedAt);
  if (updatedAt) {
    const updatedMs = Date.parse(updatedAt);
    if (Number.isFinite(updatedMs)) {
      snapshot.ageSeconds = Math.max(0, Math.round((Date.now() - updatedMs) / 1000));
    }
  }

  const phase = readString(snapshot.status?.phase);
  snapshot.stale =
    phase !== undefined &&
    RUNNING_PHASES.has(phase) &&
    snapshot.ageSeconds !== undefined &&
    snapshot.ageSeconds > STALE_AFTER_SECONDS;

  return snapshot;
}

export function formatRunStatus(snapshot: RunStatusSnapshot): string {
  if (!snapshot.runDirectory) {
    return [
      "hedera-harness status",
      "",
      `  No harness run found for ${snapshot.workspacePath}.`,
      "",
      "  Start one with `hedera-harness run`, or pass --workspace <path>.",
    ].join("\n");
  }

  const status = snapshot.status ?? {};
  const phase = readString(status.phase);
  const rows: Array<[string, string]> = [];

  rows.push(["run", snapshot.runDirectory]);
  if (snapshot.specName) {
    rows.push(["spec", `${snapshot.specName} (${snapshot.specPath})`]);
  }
  if (snapshot.branch) rows.push(["branch", snapshot.branch]);

  rows.push(["phase", describePhase(status, snapshot.report)]);

  const attempt = readNumber(status.attempt);
  const maxAttempts =
    readNumber(status.maxAttemptsThisCycle) ?? snapshot.report?.maxAttempts;
  if (attempt !== undefined) {
    rows.push([
      "attempt",
      maxAttempts !== undefined ? `${attempt} of ${maxAttempts}` : String(attempt),
    ]);
  }

  const elapsed = readNumber(status.elapsedSeconds);
  if (elapsed !== undefined) rows.push(["elapsed", formatDuration(elapsed)]);

  const activity = readString(status.lastActivity);
  if (activity) rows.push(["activity", activity]);

  const started = readNumber(status.toolCallsStarted);
  const completed = readNumber(status.toolCallsCompleted);
  if (started !== undefined || completed !== undefined) {
    rows.push(["tools", `${started ?? 0} started, ${completed ?? 0} completed`]);
  }

  const findings = describeFindings(status, snapshot.report);
  if (findings) rows.push(["findings", findings]);

  if (status.infrastructureFailure === true) {
    rows.push(["note", "aborted on an infrastructure failure, not an app defect"]);
  }

  if (snapshot.ageSeconds !== undefined) {
    rows.push([
      "updated",
      snapshot.stale
        ? `${formatDuration(snapshot.ageSeconds)} ago — no heartbeat, the run may have stopped`
        : `${formatDuration(snapshot.ageSeconds)} ago`,
    ]);
  }

  const activityLog = readString(status.activityLogPath);
  if (activityLog && phase !== undefined && RUNNING_PHASES.has(phase)) {
    rows.push(["agent log", activityLog]);
  }
  if (snapshot.report) {
    rows.push(["report", path.join(snapshot.runDirectory, "reports", "report.json")]);
  }

  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    "hedera-harness status",
    "",
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ].join("\n");
}

/**
 * Each `writeStatusFile` call replaces the file, so the fields present depend on
 * the phase that wrote it last. Read the phase first and only claim what that
 * particular write actually carries.
 */
function describePhase(status: Record<string, unknown>, report: RunReport | null): string {
  const phase = readString(status.phase);
  const stage = readString(status.stage);

  switch (phase) {
    case undefined:
      return "unknown — no status written yet";
    case "started":
      return "started";
    case "continued":
      return `continued${readNumber(status.cycle) !== undefined ? ` (cycle ${readNumber(status.cycle)})` : ""}`;
    case "generator_running":
      return `${stage ?? "GENERATE"} — generating`;
    case "repair_running":
      return `${stage ?? "GENERATE"} — repairing`;
    case "validated":
      return `validated — attempt ${status.passed === true ? "PASSED" : "FAILED"}`;
    case "finished":
      return `finished — ${status.passed === true ? "PASSED" : "FAILED"}${
        readNumber(status.attempts) !== undefined
          ? ` after ${readNumber(status.attempts)} attempt(s)`
          : ""
      }`;
    case "cleanup_complete":
      return `cleanup complete${report ? ` — run ${report.passed ? "PASSED" : "FAILED"}` : ""}`;
    default:
      return phase;
  }
}

function describeFindings(
  status: Record<string, unknown>,
  report: RunReport | null,
): string | undefined {
  const open = readStringArray(status.openFindingIds) ?? report?.openFindingIds;
  const fixed = readStringArray(status.fixedFindingIds) ?? report?.fixedFindingIds;
  if (!open && !fixed) return undefined;

  const parts = [`${open?.length ?? 0} open`];
  if (fixed && fixed.length > 0) parts.push(`${fixed.length} fixed`);
  return parts.join(", ");
}

/**
 * Newest `.harness/runs/<id>` whose layout metadata names this workspace.
 *
 * Mirrors how the run loop picks a directory, minus the directory creation —
 * run ids sort lexicographically by timestamp, so the last one is the newest.
 */
async function findNewestRunDirectory(workspacePath: string): Promise<string | null> {
  const runsRoot = path.join(workspacePath, ".harness", "runs");

  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }

  const matches: string[] = [];
  for (const entry of entries.sort()) {
    const runDirectory = path.join(runsRoot, entry);
    const meta = await readLayoutMeta(runDirectory);
    if (meta && path.resolve(meta.workspacePath) === workspacePath) {
      matches.push(runDirectory);
    }
  }

  return matches.length > 0 ? matches[matches.length - 1]! : null;
}

async function readSpecName(specPath: string): Promise<string | undefined> {
  try {
    const loaded = await loadTemplateSpec(specPath);
    return loaded.spec.name;
  } catch {
    return undefined;
  }
}

async function readBranch(workspacePath: string): Promise<string | undefined> {
  try {
    // Null on a detached HEAD, which the run loop refuses anyway.
    return (await readGitRepoSnapshot(workspacePath)).branch ?? undefined;
  } catch {
    return undefined;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    // Missing, or caught mid-write by a run that is still going.
    return null;
  }
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? (value as string[])
    : undefined;
}
