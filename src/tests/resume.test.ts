import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResumeError, assertContinuable, lastRun } from "../resume.js";
import { runCommand } from "../commands.js";

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

  const resumable = await lastRun(repo, "", "harness/2026-09-22T14-05-36-835Z");
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

  const resumable = await lastRun(repo, "", "harness/passed");
  assert.equal(resumable.branch, "harness/passed");
  assert.deepEqual(resumable.failures, [], "a pass has nothing to start from — that is the point");
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

  const resumable = await lastRun(repo, "", "harness/real");
  assert.equal(resumable.branch, "harness/real");
  assert.equal(resumable.failures.length, 1);
});

test("nothing anywhere reached a branch, and it says so", async () => {
  const repo = await ranAs("2026-09-23T00-00-00-000Z", { attempts: {} });
  await assert.rejects(() => lastRun(repo, "", "main"), ResumeError);
});

test("no runs at all says so, rather than failing obscurely later", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await assert.rejects(() => lastRun(repo, "", "main"), /no previous run/);
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

  const resumable = await lastRun(repo, "2026-09-30T00-00-00-000Z", "harness/real");
  assert.equal(resumable.branch, "harness/real");
});

/** Adds a run that started on `from` and made `branch`, to an existing repo. */
async function alsoRan(repo: string, stamp: string, from: string, branch: string): Promise<void> {
  const dir = join(repo, ".harness", "runs", stamp);
  await mkdir(join(dir, "attempt-1"), { recursive: true });
  const events = [
    { type: "run:started", stamp, from },
    { type: "branch", branch },
  ];
  await writeFile(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
  await writeFile(join(dir, "attempt-1", "feedback.json"), JSON.stringify({ ok: true, failures: [] }));
}

/** `.harness/runs/` is shared by every branch, so the newest run is often another app's. */
test("continuing takes the newest run of your branch, not the newest run", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  assert.equal((await lastRun(repo, "", "templates/dvp")).branch, "harness/dvp-run");
  assert.equal((await lastRun(repo, "", "templates/audit")).branch, "harness/audit-run");
});

test("standing on the branch a run made continues that run", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  assert.equal((await lastRun(repo, "", "harness/dvp-run")).branch, "harness/dvp-run");
});

/** A second spec built on a passed run starts from that run's branch, and continuing from there finds it. */
test("a run stacked on a harness branch is found from that branch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-13T08-00-00-000Z", "templates/dvp", "harness/dvp-run");
  await alsoRan(repo, "2026-10-14T09-00-00-000Z", "harness/dvp-run", "harness/dvp-second");

  assert.equal((await lastRun(repo, "", "harness/dvp-run")).branch, "harness/dvp-second");
});

test("with nothing of yours to continue, it names whose run is newest instead of taking it", async () => {
  const repo = await mkdtemp(join(tmpdir(), "harness-resume-"));
  await alsoRan(repo, "2026-10-14T04-00-00-000Z", "templates/audit", "harness/audit-run");

  await assert.rejects(
    () => lastRun(repo, "", "templates/bond"),
    (error: Error) =>
      error instanceof ResumeError &&
      error.message.includes("templates/bond") &&
      error.message.includes("templates/audit") &&
      error.message.includes("harness/audit-run"),
  );
});

async function sh(repo: string, command: string): Promise<string> {
  const { output } = await runCommand({ run: command }, repo, 10_000);
  return output.trim();
}

/** A repo with one commit on `main`, and `harness/run` branched from it. */
async function repoWithRun(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "harness-continuable-"));
  await sh(
    repo,
    "git init -q -b main && git config user.email t@t && git config user.name t" +
      " && git commit -q --allow-empty -m base && git branch harness/run",
  );
  return repo;
}

test("a run's branch behind yours is refused, counting what it would drop", async () => {
  const repo = await repoWithRun();
  await sh(repo, "git commit -q --allow-empty -m 'feat: first iteration'");

  await assert.rejects(
    assertContinuable("harness/run", "main", repo),
    (error: Error) => error instanceof ResumeError && /behind main by 1 commit/.test(error.message),
  );
});

test("a run's branch at or ahead of yours continues", async () => {
  const repo = await repoWithRun();
  await assertContinuable("harness/run", "main", repo);

  await sh(repo, "git switch -q harness/run && git commit -q --allow-empty -m 'harness: attempt 1'");
  await sh(repo, "git switch -q main");
  await assertContinuable("harness/run", "main", repo);
});
