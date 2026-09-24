/**
 * Picking up a run that stopped.
 *
 * A run that dies at its third attempt of three leaves everything that matters
 * on disk — every attempt is committed to its branch, and every failure is in
 * its `feedback.json` — and no way to use it. Starting again from the spec
 * throws away work the harness itself preserved, which is the one outcome its
 * commit-every-attempt discipline exists to prevent.
 *
 * What comes back is the code and what was wrong with it. What does not is the
 * generator's conversation: session ids are not persisted, so the next attempt
 * reads the failures rather than remembering them. That is the honest half —
 * a repair prompt is what a fresh session after a reset gets anyway, and it
 * has worked every time the reset has fired.
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
 */
export async function lastRun(repoRoot: string, excluding: string): Promise<Resumable> {
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
  for (const stamp of entries.reverse()) {
    const dir = join(runs, stamp);
    const branch = await branchOf(dir);
    if (branch === null) continue;

    const reported = await lastReported(dir);
    return {
      stamp,
      branch,
      attempt: reported?.attempt ?? 0,
      failures: reported?.failures ?? [],
      artifacts: join(ARTIFACT_DIR, "runs", stamp, `attempt-${reported?.attempt ?? 1}`),
    };
  }
  throw new ResumeError(
    `no run in ${runs} got as far as a branch, so there is no work to continue from`,
  );
}

async function branchOf(dir: string): Promise<string | null> {
  const source = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => null);
  if (source === null) return null;
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line) as { type?: string; branch?: string };
    if (event.type === "branch" && typeof event.branch === "string") return event.branch;
  }
  return null;
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
