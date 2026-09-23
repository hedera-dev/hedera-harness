import assert from "node:assert/strict";
import test from "node:test";
import { describeFailure, fromStage, fromVerdict } from "../failure.js";
import { endingOf } from "../messages.js";
import { cited, locators, nudge } from "../evaluate.js";
import type { StageFailure } from "../test.js";

function stage(output: string, over: Partial<StageFailure> = {}): StageFailure {
  return {
    stage: "build",
    command: { run: "yarn next:build" },
    code: 1,
    timedOut: false,
    timeoutMs: 20 * 60_000,
    artifact: "attempt-1/build.txt",
    output,
    ...over,
  };
}

/**
 * The convergence mechanism in one assertion. The evaluator is fresh every
 * attempt and has never seen the app before, so it words the same bug
 * differently each time. Hashing what it said would make one recurring failure
 * look like a new one every attempt — the counts would read "1 fixed, 1 new"
 * forever, and the fresh-session reset would never fire.
 */
test("one bug described two ways is still one bug", () => {
  const first = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "the timestamp shows undefined while loading", evidence: ["a.png"] },
    ],
  });
  const second = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "a placeholder appears before data arrives", evidence: ["b.png"] },
    ],
  });
  assert.equal(first[0]?.id, second[0]?.id);
});

test("two bugs in different places are two bugs", () => {
  const [a, b] = fromVerdict({
    pass: false,
    failures: [
      { where: "/status", what: "same words", evidence: ["a.png"] },
      { where: "#status-error", what: "same words", evidence: ["a.png"] },
    ],
  });
  assert.notEqual(a?.id, b?.id);
});

test("a moving line number does not make a build failure look new", () => {
  const before = fromStage(stage("ok\nError: Cannot find module './x' at line 42\nmore"));
  const after = fromStage(stage("ok\nError: Cannot find module './x' at line 108\nmore"));
  assert.equal(before.id, after.id);
  assert.equal(before.kind === "stage" && before.error, "Error: Cannot find module './x' at line N");
});

test("a different error in the same stage is a different failure", () => {
  const a = fromStage(stage("Error: Cannot find module './x'"));
  const b = fromStage(stage("Error: Unexpected token"));
  assert.notEqual(a.id, b.id);
});

test("the fields carried are the ones a reader needs, not a sentence", () => {
  const failure = fromStage(stage("Error: boom"));
  assert.equal(failure.kind === "stage" && failure.artifact, "attempt-1/build.txt");
});

/**
 * These two strings are what the *agent* is told went wrong, so they are an
 * interface, not cosmetics. Restructuring the type behind them silently dropped
 * "after 20 minutes" from the timeout case once already — which is the
 * difference between telling the agent its command hung and telling it nothing.
 */
test("the repair prompt says what went wrong, in full", () => {
  assert.equal(
    describeFailure(fromStage(stage("Error: boom", { timedOut: true, code: null }))),
    "build: `yarn next:build` timed out after 20 minutes",
  );
  assert.equal(
    describeFailure({ kind: "verdict", id: "x", where: "/a", what: "broken", evidence: ["p.png"] }),
    "/a: broken [p.png]",
  );
});

/**
 * Both numbers on the generation summary were wrong, in ways that only showed
 * against a real transcript: turns were counted as assistant messages (84 for a
 * conversation the SDK measured at 41 and capped at 300), and one conversation
 * can end twice when a background subagent wakes it with a task-notification.
 */
test("turns accumulate across wake-ups; cost does not", () => {
  const stream = [
    { type: "assistant" },
    { type: "result", num_turns: 39, total_cost_usd: 0.62, is_error: false },
    { type: "assistant" },
    // The second ending: a background subagent finished and woke the session.
    { type: "result", num_turns: 2, total_cost_usd: 0.7, is_error: false, origin: { kind: "task-notification" } },
  ];
  let turns = 0;
  let cost: number | undefined;
  for (const message of stream) {
    const ending = endingOf(message, 300);
    if (ending === null) continue;
    turns += ending.turns;
    cost = ending.costUsd;
  }
  assert.equal(turns, 41, "turns are per wake-up, so they sum");
  assert.equal(cost, 0.7, "total_cost_usd is already cumulative, so the last one wins");
});

/**
 * Each pass is its own `query()` with its own allowance, so treating every
 * stop as recoverable quietly buys a second helping of whatever was just
 * exhausted — which is fine for turns and exactly wrong for spend.
 */
test("only a bound another turn could satisfy is recoverable", () => {
  assert.deepEqual(endingOf({ type: "result", is_error: true, subtype: "error_max_turns" }, 300)?.failure, {
    reason: "it used all 300 of its turns",
    recoverable: true,
  });
  assert.deepEqual(endingOf({ type: "result", is_error: true, subtype: "error_max_budget_usd" }, 300)?.failure, {
    reason: "it reached its spend limit",
    recoverable: false,
  });
  assert.equal(
    endingOf({ type: "result", is_error: true, subtype: "error_during_execution" }, 300)?.failure?.recoverable,
    false,
  );
  assert.equal(endingOf({ type: "result", is_error: false }, 300)?.failure, null);
  assert.equal(endingOf({ type: "assistant" }, 300), null);
});

/**
 * An evaluator cut off mid-check needs the opposite advice from one that
 * finished and forgot to answer. Telling the first it already has what it needs
 * buys a fast verdict at the cost of a thorough one — and since a breached
 * bound now becomes a no-verdict rather than killing the run, that is a path
 * the harness takes on its own.
 */
test("the retry tells a cut-off evaluator to finish, not to conclude", () => {
  const cutOff = nudge({ reason: "it used all 120 of its turns", why: "cut-off" });
  assert.match(cutOff, /stopped before you were done/);
  assert.match(cutOff, /Do not pass a requirement you have not actually checked/);

  const unreported = nudge({ reason: "finished without calling submit_verdict", why: "unreported" });
  assert.match(unreported, /did the work and ended without reporting it/);
  assert.doesNotMatch(unreported, /stopped before you were done/);

  const unevidenced = nudge({ reason: "cites evidence that is not there", why: "unevidenced" });
  assert.match(unevidenced, /cited evidence the harness cannot find/);
  assert.match(unevidenced, /A finding nobody can check is not a finding/);
});

/**
 * Both halves of the citation bug. `resolves()` accepted three spellings of one
 * file and the repair prompt then built a path from the raw string, so
 * `evidence/shot.png` became `evidence/evidence/shot.png` — unopenable, in the
 * one message whose job is to hand the agent something it can open.
 */
test("a citation is reduced to the name it has inside evidence/", () => {
  assert.equal(cited("shot.png"), "shot.png");
  assert.equal(cited("evidence/shot.png"), "shot.png");
  assert.equal(cited("./evidence/shot.png"), "shot.png");
  assert.equal(cited("/tmp/harness-eval-x/evidence/shot.png"), "shot.png");
  assert.equal(cited("nested/shot.png"), "nested/shot.png", "a directory under evidence/ is kept");
  const url = "https://testnet.mirrornode.hedera.com/api/v1/blocks";
  assert.equal(cited(url), url, "a URL is not a path");
});

test("a verdict's findings are compared by where, not by how they are evidenced", () => {
  const one = { pass: false, failures: [{ what: "a", where: "/x", evidence: ["a.png"] }] };
  const reworded = { pass: false, failures: [{ what: "a, differently", where: "/x", evidence: ["b.png"] }] };
  const dropped = { pass: true, failures: [] };

  assert.equal(locators(one), locators(reworded), "recitation and rewording are not a new judgement");
  assert.notEqual(locators(one), locators(dropped), "dropping a finding is");
  assert.equal(locators(null), "");
});

/**
 * A usage limit arrives as `subtype: "success"` with `is_error: true`, and the
 * only useful part is the payload. Reporting the label alone produced "the
 * evaluator stopped because it stopped early (success)" while "You've hit your
 * session limit · resets 4:50pm" sat unread in the same message.
 */
test("when the SDK stops for a reason it states, that reason is what is reported", () => {
  const limited = endingOf(
    {
      type: "result",
      is_error: true,
      subtype: "success",
      result: "You've hit your session limit · resets 4:50pm (Europe/Bucharest)",
    },
    300,
  );
  assert.match(limited?.failure?.reason ?? "", /session limit · resets 4:50pm/);
  assert.equal(limited?.failure?.recoverable, false);

  // A bound the harness set is named by the harness, not by the payload.
  const capped = endingOf({ type: "result", is_error: true, subtype: "error_max_turns" }, 300);
  assert.equal(capped?.failure?.reason, "it used all 300 of its turns");
});
