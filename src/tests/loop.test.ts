import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import type { Agents } from "../loop.js";
import type { Outcome } from "../evaluate.js";
import { type HarnessEvent, collect, reset } from "../events.js";
import { runCommand } from "../commands.js";
import { runLoop } from "../loop.js";
import { Run } from "../run.js";

afterEach(() => reset());

/**
 * A port nobody else is on. These tests used a fixed one, so a dev server left
 * behind by an unrelated run made every one of them fail at once, for a reason
 * that looked nothing like the cause.
 */
function freePort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

/**
 * Drives the loop across scripted attempts.
 *
 * Seven live runs have all passed on the first attempt, so everything the loop
 * decides *between* attempts — what counts as the same failure again, when the
 * resumed session is circling and must be abandoned, when to stop — has never
 * run outside a unit test of its parts. This runs it as a loop, which is where
 * the threading bugs would live: `previous` not carried forward, the session
 * not actually dropped, one attempt too many or too few.
 *
 * Only the two agent calls are stubbed. The commands, the commit and the dev
 * server are real.
 */
function fails(where: string, evidence = ["shot.png"]): Outcome {
  return {
    type: "verdict",
    verdict: { pass: false, failures: [{ what: "broken", where, evidence }] },
    checks: [],
  };
}

const PASSES: Outcome = { type: "verdict", verdict: { pass: true, failures: [] }, checks: [] };

interface Driven {
  events: HarnessEvent[];
  passed: boolean;
  attempts: number;
  /** One entry per generation: whether it was asked to resume, and what it was told. */
  generations: Array<{ resumed: boolean; prompt: string }>;
  dir: string;
}

async function drive(verdicts: Outcome[], maxAttempts = 3): Promise<Driven> {
  const repo = await mkdtemp(join(tmpdir(), "harness-loop-"));
  await runCommand(
    { run: "git init -q -b main && git config user.email t@t && git config user.name t" },
    repo,
    10_000,
  );
  await writeFile(join(repo, "package.json"), '{"name":"x","private":true}\n');
  await writeFile(join(repo, "spec.md"), "# Spec\n");
  await runCommand({ run: "git add -A && git commit -qm init" }, repo, 10_000);

  const run = await Run.create(repo, "stamp");
  const generations: Driven["generations"] = [];

  const agents: Agents = {
    // Each generation writes a file, so every attempt has something to commit.
    generate: (async (options) => {
      generations.push({ resumed: options.resume !== undefined, prompt: options.prompt });
      await writeFile(join(repo, `attempt-${options.attempt}.txt`), "work\n");
      return {
        sessionId: "session-1",
        skills: ["demo"],
        turns: 3,
        costUsd: 0.01,
        durationMs: 1,
      };
    }) as Agents["generate"],
    evaluate: (async (options) =>
      verdicts[options.attempt - 1] ?? PASSES) as Agents["evaluate"],
  };

  const port = freePort();
  const { events } = collect();
  const result = await runLoop({
    config: {
      install: { run: "true" },
      build: { run: "true" },
      test: { run: "true" },
      serve: { run: `echo "http://127.0.0.1:${port}" && python3 -m http.server ${port}` },
    },
    repoRoot: repo,
    run,
    specPath: join(repo, "spec.md"),
    spec: "# Spec",
    branch: "harness/stamp",
    maxAttempts,
    model: "stub",
    judgeModel: "stub-judge",
    checks: [],
    agents,
  });

  return { events, passed: result.passed, attempts: result.attempts, generations, dir: run.dir };
}

function tallies(events: HarnessEvent[]): Array<[number, number, number]> {
  return events
    .filter((event) => event.type === "attempt:finished")
    .map((event) =>
      event.type === "attempt:finished" ? [event.open, event.fixed, event.fresh] : [0, 0, 0],
    );
}

test("the same failure twice abandons the session", async () => {
  // `/a` survives both attempts, so attempt 3 must not resume the conversation
  // that has already failed to fix it twice.
  const driven = await drive([fails("/a"), fails("/a"), fails("/a")]);

  assert.deepEqual(tallies(driven.events), [
    [0, 0, 1],
    [1, 0, 0],
    [1, 0, 0],
  ]);
  assert.deepEqual(
    driven.generations.map((generation) => generation.resumed),
    [false, true, false],
    "attempt 2 resumes; attempt 3 must start fresh after the repeat",
  );
  assert.equal(driven.passed, false);
  assert.equal(driven.attempts, 3);
});

test("a different failure each time keeps the session", async () => {
  // The agent is fixing things and breaking others — circling, but not stuck on
  // one failure, so the conversation is still worth keeping.
  const driven = await drive([fails("/a"), fails("/b"), fails("/c")]);

  assert.deepEqual(tallies(driven.events), [
    [0, 0, 1],
    [0, 1, 1],
    [0, 1, 1],
  ]);
  assert.deepEqual(
    driven.generations.map((generation) => generation.resumed),
    [false, true, true],
  );
});

test("passing stops the loop immediately", async () => {
  const driven = await drive([fails("/a"), PASSES, fails("/c")]);

  assert.equal(driven.passed, true);
  assert.equal(driven.attempts, 2);
  assert.equal(driven.generations.length, 2, "a third attempt must not be generated");
});

test("the repair prompt carries the failure and a path to its evidence", async () => {
  const driven = await drive([fails("/a"), PASSES]);
  const repair = driven.generations[1]?.prompt ?? "";

  assert.match(repair, /That attempt did not pass/);
  assert.match(repair, /\/a: broken/);
  assert.match(repair, /attempt-1\/evidence\/shot\.png/, "evidence must be given as a path");
});

test("a citation already prefixed with evidence/ is not doubled", async () => {
  const driven = await drive([fails("/a", ["evidence/shot.png"]), PASSES]);
  const repair = driven.generations[1]?.prompt ?? "";

  assert.match(repair, /attempt-1\/evidence\/shot\.png/);
  assert.doesNotMatch(repair, /evidence\/evidence/, "the path must stay openable");
});

test("result.json records every attempt, with the ids that identify a repeat", async () => {
  const driven = await drive([fails("/a"), fails("/a")], 2);
  const result = JSON.parse(await readFile(join(driven.dir, "result.json"), "utf8")) as {
    passed: boolean;
    attempts: number;
    history: Array<{ attempt: number; passed: boolean; failures: Array<{ id: string }> }>;
  };

  assert.equal(result.passed, false);
  assert.equal(result.history.length, 2);
  assert.equal(
    result.history[0]?.failures[0]?.id,
    result.history[1]?.failures[0]?.id,
    "one bug across two attempts must carry one id",
  );
});

/**
 * Found by mutation: moving the guard that stops the loop preparing a repair
 * after its last attempt broke nothing testable — it only announced "attempt 3
 * starts a fresh session" on a two-attempt run. Every assertion above passed
 * while the harness promised an attempt that could never happen.
 */
test("the last attempt does not announce a next one", async () => {
  const driven = await drive([fails("/a"), fails("/a")], 2);
  const notes = driven.events.filter((event) => event.type === "note");

  assert.deepEqual(notes, [], "a run that has spent its attempts has nothing left to say");
});

/**
 * Who judges is a separate decision from who writes, because a judge that
 * shares a model with the generator is the documented shape of a lenient pass.
 * A different family is not reachable while the agent is Claude Code and
 * nothing else, so this buys a different judge rather than an independent one —
 * but it is the difference between an experiment and a worry.
 */
test("the judge is asked with its own model", async () => {
  const seen: string[] = [];
  const repo = await mkdtemp(join(tmpdir(), "harness-judge-"));
  await runCommand(
    { run: "git init -q -b main && git config user.email t@t && git config user.name t" },
    repo,
    10_000,
  );
  await writeFile(join(repo, "package.json"), '{"name":"x","private":true}\n');
  await writeFile(join(repo, "spec.md"), "# Spec\n");
  await runCommand({ run: "git add -A && git commit -qm init" }, repo, 10_000);
  const run = await Run.create(repo, "stamp");
  const port = freePort();

  await runLoop({
    config: {
      install: { run: "true" },
      build: { run: "true" },
      test: { run: "true" },
      serve: { run: `echo "http://127.0.0.1:${port}" && python3 -m http.server ${port}` },
    },
    repoRoot: repo,
    run,
    specPath: join(repo, "spec.md"),
    spec: "# Spec",
    branch: "harness/stamp",
    maxAttempts: 1,
    model: "the-writer",
    judgeModel: "the-judge",
    checks: [],
    agents: {
      generate: (async (options) => {
        seen.push(`generate:${options.model}`);
        await writeFile(join(repo, "work.txt"), "x\n");
        return { sessionId: "s", skills: [], turns: 1, costUsd: 0, durationMs: 1 };
      }) as Agents["generate"],
      evaluate: (async (options) => {
        seen.push(`evaluate:${options.model}`);
        return PASSES;
      }) as Agents["evaluate"],
    },
  });

  assert.deepEqual(seen, ["generate:the-writer", "evaluate:the-judge"]);
});

/**
 * The attempt that resolves everything is the one worth reporting on, and it
 * was the only one that said nothing. A passing attempt took a shortcut that
 * emitted zeros rather than comparing against what the previous attempt had
 * failed on, so a run that fixed three bugs finished claiming it had fixed
 * none — the convergence story missing its ending.
 */
test("the attempt that passes says what it fixed", async () => {
  const driven = await drive([fails("/a"), PASSES]);
  assert.deepEqual(tallies(driven.events), [
    [0, 0, 1],
    [0, 1, 0],
  ]);
});

test("a pass with nothing before it has nothing to have fixed", async () => {
  const driven = await drive([PASSES]);
  assert.deepEqual(tallies(driven.events), [[0, 0, 0]]);
});
