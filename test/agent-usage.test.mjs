import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { AgentStreamLogger, readEventTelemetry, mergeTelemetry, summarizeStreamEvent } =
  await import(pathToFileURL(path.resolve("dist/agentStreamLogger.js")).href);

const {
  accumulateUsage,
  emptyUsageTotals,
  formatAgentUsage,
  rateLimitAbort,
  rateLimitAbortReason,
} = await import(pathToFileURL(path.resolve("dist/agentUsage.js")).href);

const { formatRunOutro } = await import(pathToFileURL(path.resolve("dist/runOutro.js")).href);

/**
 * The `result` fixture is the field set a real `claude --output-format
 * stream-json` run emits; the rate-limit statuses are the CLI's own enum
 * (`allowed`, `allowed_warning`, `rejected`).
 */
const RESULT_EVENT = {
  type: "result",
  subtype: "success",
  duration_ms: 91_000,
  total_cost_usd: 0.4003819,
  num_turns: 12,
  usage: {
    input_tokens: 1_204,
    output_tokens: 8_450,
    cache_read_input_tokens: 512_000,
    cache_creation_input_tokens: 24_000,
  },
};

function rateLimitEvent(status, extra = {}) {
  return { type: "rate_limit_event", rate_limit_info: { status, ...extra } };
}

// ── Reading telemetry off the stream ─────────────────────────────────────────

test("cost, turns and token usage are read from the result event", () => {
  const telemetry = readEventTelemetry(RESULT_EVENT);

  assert.equal(telemetry.costUsd, 0.4003819);
  assert.equal(telemetry.numTurns, 12);
  assert.equal(telemetry.inputTokens, 1_204);
  assert.equal(telemetry.outputTokens, 8_450);
  assert.equal(telemetry.cacheReadInputTokens, 512_000);
  assert.equal(telemetry.cacheCreationInputTokens, 24_000);
});

test("a result event without usage reports nothing rather than zero", () => {
  const telemetry = readEventTelemetry({ type: "result", subtype: "success" });

  // Zero would be indistinguishable from a free run and would silently drag a
  // run total downwards.
  assert.equal(telemetry.costUsd, undefined);
  assert.equal(telemetry.inputTokens, undefined);
});

test("the model is taken from the init envelope", () => {
  assert.equal(
    readEventTelemetry({ type: "system", subtype: "init", model: "opus" }).model,
    "opus",
  );
});

test("rate-limit envelopes are read for every status the cli emits", () => {
  for (const status of ["allowed", "allowed_warning", "rejected"]) {
    const telemetry = readEventTelemetry(
      rateLimitEvent(status, { rateLimitType: "five_hour", resetsAt: 1_789_066_800 }),
    );
    assert.equal(telemetry.rateLimit.status, status);
    assert.equal(telemetry.rateLimit.rateLimitType, "five_hour");
    assert.equal(telemetry.rateLimit.resetsAt, 1_789_066_800);
  }
});

test("an unrecognised rate-limit status is ignored rather than guessed at", () => {
  assert.equal(readEventTelemetry(rateLimitEvent("something_new")).rateLimit, undefined);
  assert.equal(readEventTelemetry({ type: "rate_limit_event" }).rateLimit, undefined);
});

test("later telemetry wins so the terminal result beats earlier partials", () => {
  const merged = mergeTelemetry(
    { model: "opus", costUsd: 0.1 },
    { costUsd: 0.4, outputTokens: 10, model: undefined },
  );

  assert.equal(merged.costUsd, 0.4);
  assert.equal(merged.outputTokens, 10);
  assert.equal(merged.model, "opus", "an undefined field must not erase a known one");
});

// ── Rate limit surfacing ─────────────────────────────────────────────────────

test("only a non-allowed rate limit reaches the activity log", () => {
  assert.equal(summarizeStreamEvent(rateLimitEvent("allowed")), null);

  const warned = summarizeStreamEvent(rateLimitEvent("allowed_warning", { rateLimitType: "five_hour" }));
  assert.match(warned.summary, /^RATE LIMIT allowed_warning five_hour/);

  const rejected = summarizeStreamEvent(
    rateLimitEvent("rejected", { rateLimitType: "seven_day", resetsAt: 1_789_066_800 }),
  );
  assert.match(rejected.summary, /^RATE LIMIT rejected seven_day, resets 2026-09-/);
});

test("only a rejected rate limit aborts the loop", () => {
  assert.equal(rateLimitAbortReason(undefined), undefined);
  assert.equal(rateLimitAbortReason({ rateLimit: { status: "allowed" } }), undefined);
  assert.equal(rateLimitAbortReason({ rateLimit: { status: "allowed_warning" } }), undefined);

  const reason = rateLimitAbortReason({
    rateLimit: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1_789_066_800 },
  });
  assert.match(reason, /rate limit rejected \(five_hour, resets 2026-09-/);
  assert.match(reason, /cannot succeed until it resets/);
});

test("a passing attempt never aborts, even when the agent hit its rate limit", () => {
  const rejected = { rateLimit: { status: "rejected", rateLimitType: "five_hour" } };

  // The work is delivered and the loop is about to stop anyway. Aborting here
  // would print an infrastructure abort directly under an "Attempt 1 PASSED".
  assert.equal(
    rateLimitAbort({
      passed: true,
      evaluationInfrastructureFailure: false,
      generatorTelemetry: rejected,
    }),
    undefined,
  );

  assert.ok(
    rateLimitAbort({
      passed: false,
      evaluationInfrastructureFailure: false,
      generatorTelemetry: rejected,
    }),
    "a failing attempt with a rejected limit must stop the loop",
  );
});

test("an evaluation infrastructure failure keeps its own, more specific reason", () => {
  assert.equal(
    rateLimitAbort({
      passed: false,
      evaluationInfrastructureFailure: true,
      generatorTelemetry: { rateLimit: { status: "rejected" } },
    }),
    undefined,
  );
});

test("the evaluator's rate limit aborts when the generator's is clean", () => {
  assert.ok(
    rateLimitAbort({
      passed: false,
      evaluationInfrastructureFailure: false,
      generatorTelemetry: { rateLimit: { status: "allowed" } },
      evaluatorTelemetry: { rateLimit: { status: "rejected", rateLimitType: "seven_day" } },
    }),
  );
});

// ── Run totals ───────────────────────────────────────────────────────────────

test("usage sums across agent runs", () => {
  let totals = emptyUsageTotals();
  totals = accumulateUsage(totals, { costUsd: 0.4, inputTokens: 100, outputTokens: 10 });
  totals = accumulateUsage(totals, { costUsd: 0.6, inputTokens: 50, outputTokens: 5 });

  assert.equal(totals.agentRuns, 2);
  assert.equal(totals.costedRuns, 2);
  assert.equal(Number(totals.costUsd.toFixed(2)), 1.0);
  assert.equal(totals.inputTokens, 150);
  assert.equal(totals.outputTokens, 15);
});

test("an agent that reports no telemetry is not counted as a run", () => {
  assert.deepEqual(accumulateUsage(emptyUsageTotals(), undefined), emptyUsageTotals());
});

test("a run that reported no cost still counts toward agentRuns", () => {
  // Cursor may report activity but no spend; the total must show it is partial.
  let totals = accumulateUsage(emptyUsageTotals(), { costUsd: 0.4 });
  totals = accumulateUsage(totals, { inputTokens: 10 });

  assert.equal(totals.agentRuns, 2);
  assert.equal(totals.costedRuns, 1);
  assert.match(formatAgentUsage(totals), /\$0\.40 \(1\/2 agent runs reported cost\)/);
});

test("a total with no cost at all says so instead of printing $0.00", () => {
  const totals = accumulateUsage(emptyUsageTotals(), { inputTokens: 10 });

  assert.match(formatAgentUsage(totals), /1 agent run, cost not reported/);
  assert.doesNotMatch(formatAgentUsage(totals), /\$/);
});

test("no agent runs produces no spend line at all", () => {
  assert.equal(formatAgentUsage(emptyUsageTotals()), undefined);
  assert.equal(formatAgentUsage(undefined), undefined);
});

test("token counts are abbreviated once they get large", () => {
  const totals = accumulateUsage(emptyUsageTotals(), {
    costUsd: 1.5,
    inputTokens: 1_204,
    outputTokens: 8_450,
    cacheReadInputTokens: 2_400_000,
  });

  const formatted = formatAgentUsage(totals);
  assert.match(formatted, /\$1\.50 \(1 agent run\)/);
  assert.match(formatted, /in 1\.2k/);
  assert.match(formatted, /out 8\.4k/);
  assert.match(formatted, /cached 2\.40M/);
});

// ── End to end ───────────────────────────────────────────────────────────────

test("a stream accumulates telemetry even when the rate limit precedes the result", async () => {
  const dir = await makeOsTempDir("harness-usage-");
  const logger = new AgentStreamLogger(path.join(dir, "activity.log"));
  await logger.initialize();

  for (const event of [
    rateLimitEvent("allowed_warning", { rateLimitType: "five_hour", resetsAt: 1_789_066_800 }),
    { type: "system", subtype: "init", model: "opus", session_id: "s1" },
    RESULT_EVENT,
  ]) {
    await logger.processChunk(`${JSON.stringify(event)}\n`);
  }

  const telemetry = logger.getTelemetry();
  assert.equal(telemetry.model, "opus");
  assert.equal(telemetry.costUsd, 0.4003819);
  assert.equal(telemetry.rateLimit.status, "allowed_warning");
});

test("a rate limit survives an agent killed before it emits a result", async () => {
  const dir = await makeOsTempDir("harness-usage-");
  const logger = new AgentStreamLogger(path.join(dir, "activity.log"));
  await logger.initialize();

  // The idle-timeout path kills the agent mid-stream, so there is no `result`
  // event — but the envelope explaining the stall has already gone past.
  await logger.processChunk(
    `${JSON.stringify(rateLimitEvent("rejected", { rateLimitType: "five_hour" }))}\n`,
  );

  assert.equal(logger.getTelemetry().rateLimit.status, "rejected");
  assert.ok(rateLimitAbortReason(logger.getTelemetry()));
});

test("the outro reports agent spend, and omits the line when nothing was reported", () => {
  const base = {
    session: { branch: "harness/run-demo-abc", baseBranch: "main", baseSha: "deadbeefcafebabe" },
    cleanup: { removedPaths: [], mcpStripped: false, consumerDirtyPaths: [], treeClean: true },
    specPath: ".harness/spec.yaml",
  };
  const report = {
    passed: true,
    workspacePath: "/tmp/app",
    runDirectory: "/tmp/app/.harness/runs/abc",
    attempts: 2,
    maxAttempts: 3,
    attemptsThisCycle: 2,
    openFindingIds: [],
    fixedFindingIds: [],
    validation: { findings: [] },
  };

  const withSpend = formatRunOutro({
    ...base,
    report: { ...report, agentUsage: { agentRuns: 2, costedRuns: 2, costUsd: 1.25 } },
  }).join("\n");
  assert.match(withSpend, /agentSpend=\$1\.25 \(2 agent runs\)/);

  const withoutSpend = formatRunOutro({ ...base, report }).join("\n");
  assert.doesNotMatch(withoutSpend, /agentSpend/);
});
