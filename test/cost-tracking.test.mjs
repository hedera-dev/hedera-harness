import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";
import { writeProductSkillsRepo } from "./skillFixture.mjs";

const run = promisify(execFile);
const { AgentStreamLogger, extractUsage, formatUsage } = await import(
  pathToFileURL(path.resolve("dist/agentStreamLogger.js")).href
);
const cost = await import(pathToFileURL(path.resolve("dist/costTracking.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { runSession } = await import(pathToFileURL(path.resolve("dist/sessionRunner.js")).href);
const { formatRunOutro } = await import(pathToFileURL(path.resolve("dist/runOutro.js")).href);

const CLAUDE_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 84210,
  duration_api_ms: 61000,
  num_turns: 14,
  result: "done",
  session_id: "abc",
  total_cost_usd: 1.4231,
  usage: {
    input_tokens: 1200,
    cache_creation_input_tokens: 30000,
    cache_read_input_tokens: 412000,
    output_tokens: 8800,
  },
};

// ── Stream parsing ───────────────────────────────────────────────────────────

test("a Claude result event yields cost, tokens and turns", () => {
  const usage = extractUsage(CLAUDE_RESULT);
  assert.deepEqual(usage, {
    reported: true,
    costUsd: 1.4231,
    inputTokens: 1200,
    outputTokens: 8800,
    cacheReadTokens: 412000,
    cacheCreationTokens: 30000,
    turns: 14,
  });
  assert.equal(formatUsage(usage), "$1.42 · 1.2k in / 8.8k out / 412.0k cached");
});

test("Codex turn.completed events accumulate tokens without a price", () => {
  const first = extractUsage(
    { type: "turn.completed", usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 } },
    undefined,
  );
  const second = extractUsage(
    { type: "turn.completed", usage: { input_tokens: 700, cached_input_tokens: 300, output_tokens: 20 } },
    first,
  );
  assert.equal(second.reported, true);
  assert.equal(second.costUsd, undefined);
  assert.equal(second.inputTokens, 1200);
  assert.equal(second.outputTokens, 70);
  assert.equal(second.cacheReadTokens, 400);
  assert.equal(second.turns, 2);
  assert.equal(formatUsage(second), "1.2k in / 70 out / 400 cached");
});

test("a Cursor-style result without usage leaves spend unknown rather than zero", () => {
  assert.equal(
    extractUsage({ type: "result", subtype: "success", duration_ms: 1000, is_error: false }),
    null,
  );
  assert.equal(extractUsage({ type: "assistant", usage: { input_tokens: 1 } }), null);
  assert.equal(formatUsage(undefined), "cost unknown");
  assert.equal(formatUsage({ reported: false }), "cost unknown");
});

test("the stream logger surfaces usage on progress and in the activity log", async () => {
  const dir = await makeTestTempDir("cost-stream-");
  const activityLog = path.join(dir, "activity.log");
  const logger = new AgentStreamLogger(activityLog);
  await logger.initialize();
  await logger.processChunk(
    `${JSON.stringify({ type: "system", subtype: "init", model: "opus" })}\n` +
      `${JSON.stringify(CLAUDE_RESULT)}\n`,
  );
  assert.equal(logger.getProgress().usage.costUsd, 1.4231);
  const written = await readFile(activityLog, "utf8");
  assert.match(written, /RESULT success durationMs=84210 \$1\.42 · 1\.2k in \/ 8\.8k out \/ 412\.0k cached/);
});

// ── Accumulation and budget ──────────────────────────────────────────────────

test("run cost sums reported attempts and counts the silent ones", () => {
  let tracked = cost.createRunCost(5);
  tracked = cost.recordAttemptCost(tracked, 1, { reported: true, costUsd: 1.5, inputTokens: 10, outputTokens: 5 });
  tracked = cost.recordAttemptCost(tracked, 2, undefined);
  tracked = cost.recordAttemptCost(tracked, 3, { reported: true, costUsd: 2.25, inputTokens: 20, outputTokens: 7 });

  assert.equal(tracked.totalUsd, 3.75);
  assert.equal(tracked.inputTokens, 30);
  assert.equal(tracked.outputTokens, 12);
  assert.equal(tracked.unknownAttempts, 1);
  assert.equal(cost.isBudgetReached(tracked), false);
  assert.equal(cost.formatAttemptSpend(tracked, 3), "$2.25 this attempt, $3.75 so far, budget $5.00");
  assert.equal(cost.formatAttemptSpend(tracked, 2), "cost unknown — the agent reported no usage, so budget $5.00 cannot be enforced");
  assert.equal(cost.formatRunCost(tracked), "$3.75 + 1 attempt(s) unreported (budget $5.00)");

  tracked = cost.recordAttemptCost(tracked, 4, { reported: true, costUsd: 1.25 });
  assert.equal(cost.isBudgetReached(tracked), true);
  assert.equal(
    cost.formatRunCost({ ...tracked, budgetExhausted: true }),
    "$5.00 + 1 attempt(s) unreported — budget $5.00 exhausted",
  );
});

test("an unknown total never trips the budget, and says why", () => {
  let tracked = cost.createRunCost(2);
  tracked = cost.recordAttemptCost(tracked, 1, undefined);
  tracked = cost.recordAttemptCost(tracked, 2, undefined);
  assert.equal(tracked.totalUsd, undefined);
  assert.equal(cost.isBudgetReached(tracked), false);
  assert.equal(cost.formatRunCost(tracked), "unknown (agent reported no usage)");

  const tokensOnly = cost.recordAttemptCost(cost.createRunCost(), 1, {
    reported: true,
    inputTokens: 2500,
    outputTokens: 400,
  });
  assert.equal(cost.formatRunCost(tokensOnly), "2.5k in / 400 out tokens (no price reported)");
});

test("a seeded run cost carries earlier increments forward under one budget", () => {
  const first = cost.recordAttemptCost(cost.createRunCost(10), 1, { reported: true, costUsd: 4 });
  const second = cost.recordAttemptCost(cost.createRunCost(10, first), 2, { reported: true, costUsd: 3 });
  assert.equal(second.totalUsd, 7);
  assert.equal(second.attempts.length, 2);
  assert.equal(first.attempts.length, 1, "seeding must not mutate the earlier record");
});

// ── Recipe ───────────────────────────────────────────────────────────────────

async function writeRecipe(body) {
  const root = await makeTestTempDir("cost-spec-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  const specPath = path.join(root, ".harness", "spec.yaml");
  await writeFile(specPath, body);
  return specPath;
}

const BASE_RECIPE = `schemaVersion: 3
name: budgeted
baseline:
  commands:
    - name: install
      command: "true"
`;

test("budget.maxCostUsd loads, is optional, and rejects nonsense", async () => {
  const { spec, warnings } = await loadTemplateSpec(
    await writeRecipe(`${BASE_RECIPE}budget:\n  maxCostUsd: 7.5\n`),
  );
  assert.equal(spec.budget.maxCostUsd, 7.5);
  assert.deepEqual(warnings.filter(w => w.includes("unknown key")), [], "budget is a known key");

  const none = await loadTemplateSpec(await writeRecipe(BASE_RECIPE));
  assert.equal(none.spec.budget, undefined);

  await assert.rejects(
    loadTemplateSpec(await writeRecipe(`${BASE_RECIPE}budget:\n  maxCostUsd: 0\n`)),
    /budget\.maxCostUsd must be a positive number/,
  );
  await assert.rejects(
    loadTemplateSpec(await writeRecipe(`${BASE_RECIPE}budget:\n  maxCostUsd: "five dollars"\n`)),
    /budget\.maxCostUsd must be a positive number/,
  );
  await assert.rejects(
    loadTemplateSpec(await writeRecipe(`${BASE_RECIPE}budget: 5\n`)),
    /Expected object "budget"/,
  );
});

// ── End to end: the loop stops on spend ──────────────────────────────────────

/**
 * A generator that always leaves the forbidden marker behind (so every attempt
 * fails) and reports a Claude-shaped result event with a fixed price. Three
 * attempts are allowed; with $0.60 per attempt and a $1.00 budget the loop must
 * stop after the second.
 */
const PRICED_AGENT = `
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const ws = process.env.MOCK_WS;
mkdirSync(path.join(ws, "built"), { recursive: true });
writeFileSync(path.join(ws, "built", "FAIL.txt"), "still broken");
const price = Number(process.env.MOCK_PRICE ?? "0");
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "mock" }) + "\\n");
if (process.env.MOCK_REPORT_USAGE !== "0") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 10, num_turns: 1, total_cost_usd: price, usage }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 10 }) + "\\n");
}
`;

async function makeBudgetProject({ budget, maxAttempts = 3 }) {
  const root = await makeTestTempDir("cost-e2e-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "agent.mjs"), PRICED_AGENT);
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await writeFile(path.join(root, ".harness", "prd.md"), "Fix the thing\n");
  const skillsRepo = await writeProductSkillsRepo(await makeTestTempDir("cost-skills-"));
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { forbidden: ["built/FAIL.txt"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: budget-demo
maxAttempts: ${maxAttempts}
${budget !== undefined ? `budget:\n  maxCostUsd: ${budget}\n` : ""}generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(path.join(root, "agent.mjs"))}
  timeoutMs: 60000
baseline:
  commands:
    - name: install
      command: "true"
`,
  );
  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await run("git", ["config", "user.email", "fixture@local"], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"], { cwd: root });
  return {
    root,
    env: { MOCK_WS: root, HARNESS_SKILLS_REPO: skillsRepo, HARNESS_SKILLS_REF: "master" },
  };
}

async function runWith(root, env) {
  const previous = { ...process.env };
  Object.assign(process.env, env, { HUSKY: "0" });
  try {
    return await runSession({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
      skipToolChecks: true,
    });
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("the loop stops once reported spend reaches budget.maxCostUsd", async () => {
  const { root, env } = await makeBudgetProject({ budget: 1, maxAttempts: 3 });

  const { report, session, outroLines } = await runWith(root, { ...env, MOCK_PRICE: "0.6" });

  assert.equal(report.passed, false);
  assert.equal(report.attempts, 2, "third attempt must not be paid for");
  assert.equal(report.cost.budgetExhausted, true);
  assert.equal(report.cost.budgetUsd, 1);
  assert.ok(Math.abs(report.cost.totalUsd - 1.2) < 1e-9, `total ${report.cost.totalUsd}`);
  assert.equal(report.cost.attempts.length, 2);
  assert.equal(report.cost.inputTokens, 2000);

  const outro = outroLines.join("\n");
  assert.match(outro, /Run STOPPED \(budget\)/);
  assert.match(outro, /cost=\$1\.20 — budget \$1\.00 exhausted/);

  const log = await readFile(path.join(session.runDirectory, "harness.log.jsonl"), "utf8").catch(
    () => "",
  );
  const events = (log || (await readFile(path.join(root, ".harness", "runs", "harness.log.jsonl"), "utf8")))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const exhausted = events.find(event => event.type === "budget_exhausted");
  assert.ok(exhausted, "budget_exhausted event is logged");
  assert.equal(exhausted.attempt, 2);
  assert.equal(exhausted.attemptsUnused, 1);
  assert.equal(events.filter(e => e.type === "generator_finished" && e.costUsd === 0.6).length, 2);
});

test("without a budget the loop spends every attempt and reports the total", async () => {
  const { root, env } = await makeBudgetProject({ maxAttempts: 2 });

  const { report, outroLines } = await runWith(root, { ...env, MOCK_PRICE: "0.6" });

  assert.equal(report.passed, false);
  assert.equal(report.attempts, 2);
  assert.equal(report.cost.budgetExhausted, false);
  assert.equal(report.cost.budgetUsd, undefined);
  assert.ok(Math.abs(report.cost.totalUsd - 1.2) < 1e-9);
  assert.match(outroLines.join("\n"), /Run FAILED/);
  assert.match(outroLines.join("\n"), /cost=\$1\.20$/m);
});

test("an agent that reports no usage cannot exhaust a budget, and the outro says so", async () => {
  const { root, env } = await makeBudgetProject({ budget: 0.01, maxAttempts: 2 });

  const { report, outroLines } = await runWith(root, { ...env, MOCK_REPORT_USAGE: "0" });

  assert.equal(report.attempts, 2, "unknown spend never stops the loop");
  assert.equal(report.cost.budgetExhausted, false);
  assert.equal(report.cost.totalUsd, undefined);
  assert.equal(report.cost.unknownAttempts, 2);
  assert.match(outroLines.join("\n"), /cost=unknown \(agent reported no usage\)/);
});

test("outro renders older reports that have no cost block", () => {
  const lines = formatRunOutro({
    report: {
      passed: true,
      workspacePath: "/w",
      runDirectory: "/w/.harness/runs/x",
      attempts: 1,
      maxAttempts: 3,
      openFindingIds: [],
      fixedFindingIds: [],
      validation: { passed: true, findings: [], commandResults: [] },
    },
    session: { branch: "harness/run-x", baseBranch: "main", baseSha: "0123456789abcdef" },
    cleanup: { removedPaths: [], mcpStripped: false, treeClean: true, consumerDirtyPaths: [] },
    specPath: ".harness/spec.yaml",
  });
  assert.equal(lines.some(line => line.startsWith("cost=")), false);
});
