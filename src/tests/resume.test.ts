import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResumeError, lastRun } from "../resume.js";

/** Builds a run directory of the shape a real run leaves behind. */
async function ranAs(
  stamp: string,
  shape: { branch?: string; attempts?: Record<number, { ok: boolean; failures: unknown[] } | null> },
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  const dir = join(repo, ".harness", "runs", stamp);
  await mkdir(dir, { recursive: true });

  const events = [{ type: "run:started", stamp }];
  if (shape.branch !== undefined) events.push({ type: "branch", branch: shape.branch } as never);
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));

  for (const [attempt, feedback] of Object.entries(shape.attempts ?? {})) {
    await mkdir(join(dir, `attempt-${attempt}`), { recursive: true });
    // null is an attempt that started and never reported — the shell a run
    // leaves when it dies mid-generation.
    if (feedback !== null) {
      await writeFile(join(dir, `attempt-${attempt}`, "feedback.json"), JSON.stringify(feedback));
    }
  }
  return repo;
}

const broke = (where: string) => ({
  kind: "verdict",
  id: "aaa111bbb222",
  where,
  what: "broken",
  evidence: ["a.png"],
});

/**
 * The case this exists for: a run that spends its last attempt and stops. Every
 * attempt is committed to its branch and every failure is in `feedback.json`,
 * and before this there was no way to use either.
 */
test("a run that died mid-attempt resumes from the last one that reported", async () => {
  const repo = await ranAs("2026-09-22T14-05-36-835Z", {
    branch: "harness/2026-09-22T14-05-36-835Z",
    attempts: {
      1: { ok: false, failures: [broke("/a")] },
      2: { ok: false, failures: [broke("/a"), broke("/b")] },
      // attempt 3 began and never reported
      3: null,
    },
  });

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/2026-09-22T14-05-36-835Z");
  assert.equal(resumable.attempt, 2, "attempt 3 exists as a directory and reported nothing");
  assert.equal(resumable.failures.length, 2);
  assert.match(resumable.artifacts, /attempt-2$/, "evidence must still resolve from the new run");
});

test("a run that passed carries its branch and nothing to repair", async () => {
  const repo = await ranAs("2026-09-23T00-00-00-000Z", {
    branch: "harness/passed",
    attempts: { 1: { ok: false, failures: [broke("/a")] }, 2: { ok: true, failures: [] } },
  });

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/passed");
  assert.deepEqual(resumable.failures, [], "a pass has nothing to start from — that is the point");
});

test("the newest run is the one continued", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/old",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  const newer = join(repo, ".harness", "runs", "2026-09-30T00-00-00-000Z");
  await mkdir(newer, { recursive: true });
  await writeFile(
    join(newer, "events.jsonl"),
    JSON.stringify({ type: "branch", branch: "harness/new" }),
  );

  assert.equal((await lastRun(repo, "")).branch, "harness/new");
});

/**
 * An interrupted run leaves a directory and nothing else, and there is usually
 * one lying around. Taking only the newest as a candidate meant a single
 * abandoned run blocked continuing until somebody tidied up — found by killing
 * a test run and then trying to continue.
 */
test("runs that never reached a branch are stepped over", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/real",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  for (const abandoned of ["2026-09-02T00-00-00-000Z", "2026-09-03T00-00-00-000Z"]) {
    const dir = join(repo, ".harness", "runs", abandoned);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.jsonl"), JSON.stringify({ type: "run:started" }));
  }

  const resumable = await lastRun(repo, "");
  assert.equal(resumable.branch, "harness/real");
  assert.equal(resumable.failures.length, 1);
});

test("nothing anywhere reached a branch, and it says so", async () => {
  const repo = await ranAs("2026-09-23T00-00-00-000Z", { attempts: {} });
  await assert.rejects(() => lastRun(repo, ""), ResumeError);
});

test("no runs at all says so, rather than failing obscurely later", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await assert.rejects(() => lastRun(repo, ""), /no previous run/);
});

/**
 * Found live rather than here: the run doing the asking already has a
 * directory, created before `--continue` is resolved. Without excluding it the
 * most recent run is always itself, and every continue reported that the
 * newest run had never reached a branch.
 */
test("a run does not continue itself", async () => {
  const repo = await ranAs("2026-09-01T00-00-00-000Z", {
    branch: "harness/real",
    attempts: { 1: { ok: false, failures: [broke("/a")] } },
  });
  const mine = join(repo, ".harness", "runs", "2026-09-30T00-00-00-000Z");
  await mkdir(mine, { recursive: true });
  await writeFile(join(mine, "events.jsonl"), JSON.stringify({ type: "run:started" }));

  const resumable = await lastRun(repo, "2026-09-30T00-00-00-000Z");
  assert.equal(resumable.branch, "harness/real");
});
