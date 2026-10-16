/**
 * Picking up a run that stopped.
 *
 * Everything that matters is already on disk: each attempt is committed to the
 * run's branch and each failure is in its `feedback.json`. This finds them so
 * the next run repairs that work instead of starting from the spec.
 *
 * What does not come back is the generator's conversation — session ids are not
 * persisted, so the next attempt reads the failures rather than remembering
 * them, exactly as a fresh session after a reset does.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptFailure } from "./failure.js";
import { ARTIFACT_DIR } from "./run.js";

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

export interface Resumable {
  /** The run being continued, for saying so out loud. */
  stamp: string;
  /** Where its work is. The new run branches from here rather than from your branch. */
  branch: string;
  /** The last attempt that got far enough to report, or 0 when none did. */
  attempt: number;
  failures: AttemptFailure[];
  /** Run-relative, so a failure's evidence still resolves from the new run. */
  artifacts: string;
}

/**
 * The most recent run, whether or not it finished. A run that passed is as
 * resumable as one that died — continuing after a pass is how a second spec
 * builds on the first.
 *
 * Only a run that started from `onBranch`, or produced it, is a candidate:
 * `.harness/runs/` sits outside git and is shared by every branch, so in a repo
 * holding more than one app the newest run is often another app's.
 */
export async function lastRun(repoRoot: string, excluding: string, onBranch: string): Promise<Resumable> {
  const runs = join(repoRoot, ARTIFACT_DIR, "runs");
  // The run asking the question already has a directory — it is created before
  // this is resolved, so without excluding it the most recent run is always
  // itself, and the answer is always "that one never reached a branch".
  const entries = (await readdir(runs).catch(() => [] as string[]))
    .filter((entry) => entry !== excluding)
    .sort();
  if (entries.length === 0) throw new ResumeError(`there is no previous run in ${runs}`);

  // Backwards until one has work. A run interrupted before its branch existed
  // leaves a directory and nothing else, and there is usually one of those
  // lying around — treating the newest as the only candidate would mean a
  // single abandoned run blocked continuing until somebody tidied up.
  let newestElsewhere: { stamp: string; from: string | null; branch: string } | null = null;
  for (const stamp of entries.reverse()) {
    const dir = join(runs, stamp);
    const { from, branch } = await branchesOf(dir);
    if (branch === null) continue;
    if (from !== onBranch && branch !== onBranch) {
      newestElsewhere ??= { stamp, from, branch };
      continue;
    }

    const reported = await lastReported(dir);
    return {
      stamp,
      branch,
      attempt: reported?.attempt ?? 0,
      failures: reported?.failures ?? [],
      artifacts: join(ARTIFACT_DIR, "runs", stamp, `attempt-${reported?.attempt ?? 1}`),
    };
  }
  if (newestElsewhere !== null) {
    const { stamp, from, branch } = newestElsewhere;
    throw new ResumeError(
      `no run started from or produced ${onBranch}, so there is nothing of yours to continue. ` +
        `The newest run, ${stamp}, went from ${from ?? "an unrecorded branch"} to ${branch}: ` +
        `switch to ${from ?? branch} to continue it, or drop --continue to build on ${onBranch}.`,
    );
  }
  throw new ResumeError(
    `no run in ${runs} got as far as a branch, so there is no work to continue from`,
  );
}

/** Where a run started (`run:started.from`) and the branch it made (`branch`). */
async function branchesOf(dir: string): Promise<{ from: string | null; branch: string | null }> {
  const found: { from: string | null; branch: string | null } = { from: null, branch: null };
  const source = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => null);
  if (source === null) return found;
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as { type?: string; branch?: string; from?: string };
    if (event.type === "run:started" && typeof event.from === "string") found.from = event.from;
    if (event.type === "branch" && typeof event.branch === "string") found.branch = event.branch;
  }
  return found;
}

/**
 * The highest attempt that wrote feedback. The one after it may exist as a
 * directory and hold nothing — a run that died mid-generation leaves the shell
 * of an attempt that never reported.
 */
async function lastReported(
  dir: string,
): Promise<{ attempt: number; failures: AttemptFailure[] } | null> {
  const attempts = (await readdir(dir).catch(() => [] as string[]))
    .map((entry) => /^attempt-(\d+)$/.exec(entry)?.[1])
    .filter((number): number is string => number !== undefined)
    .map(Number)
    .sort((a, b) => b - a);

  for (const attempt of attempts) {
    const source = await readFile(join(dir, `attempt-${attempt}`, "feedback.json"), "utf8").catch(
      () => null,
    );
    if (source === null) continue;
    const feedback = JSON.parse(source) as { ok: boolean; failures: AttemptFailure[] };
    return { attempt, failures: feedback.ok ? [] : feedback.failures };
  }
  return null;
}
