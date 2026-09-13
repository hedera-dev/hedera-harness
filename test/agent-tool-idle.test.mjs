import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const {
  CommandAgentProvider,
  DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS,
  readAgentToolIdleTimeoutMs,
} = await import(pathToFileURL(path.resolve("dist/providers/commandAgentProvider.js")).href);

/**
 * A fake agent: announce a tool call on the stream, go silent for `silentMs`
 * the way every CLI does while its command runs, then close the call and exit.
 * The events are Codex's shape; the logger's decoding is covered elsewhere.
 */
function fakeAgent(silentMs, { closesCall = true } = {}) {
  const started = JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "yarn build" } });
  const completed = JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "yarn build", exit_code: 0 } });
  const script = [
    `console.log(${JSON.stringify(started)});`,
    `setTimeout(() => {`,
    closesCall ? `  console.log(${JSON.stringify(completed)});` : "",
    `  process.exit(0);`,
    `}, ${silentMs});`,
  ].join("\n");
  return new CommandAgentProvider({ provider: "command", command: process.execPath, args: ["-e", script, "{prompt}"] });
}

async function runWith(provider, env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const root = await makeTestTempDir("tool-idle-");
    return await provider.run({
      workspacePath: root,
      prompt: "p",
      attempt: 1,
      activityLogPath: path.join(root, "activity.log"),
    });
  } finally {
    process.env = saved;
  }
}

test("tool idle budget defaults to 10 minutes and is overridable", () => {
  assert.equal(DEFAULT_AGENT_TOOL_IDLE_TIMEOUT_MS, 600_000);
  assert.equal(readAgentToolIdleTimeoutMs({}), 600_000);
  assert.equal(readAgentToolIdleTimeoutMs({ HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "120000" }), 120_000);
  assert.equal(readAgentToolIdleTimeoutMs({ HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "nope" }), 600_000);
});

test("a long-running tool call is not mistaken for a stuck agent", async () => {
  // Regression: silence longer than the idle limit killed the agent while its
  // own command was still running.
  const result = await runWith(fakeAgent(2_500), {
    HARNESS_AGENT_IDLE_TIMEOUT_MS: "800",
    HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "10000",
  });
  assert.equal(result.timedOut, false, "the build finished; the agent must not be killed");
  assert.equal(result.exitCode, 0);
});

test("a tool call that never returns is still stopped at the tool budget", async () => {
  const startedAt = Date.now();
  const result = await runWith(fakeAgent(60_000, { closesCall: false }), {
    HARNESS_AGENT_IDLE_TIMEOUT_MS: "500",
    HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "1500",
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 15_000, "bounded by the tool budget, not the wall clock");
  assert.match(result.stderr, /no output for 1500ms/);
});

test("an agent with no call in flight still stops at the plain idle limit", async () => {
  // The case the idle limit was written for: tools finished, process hangs.
  const hung = new CommandAgentProvider({
    provider: "command",
    command: process.execPath,
    args: ["-e", "setTimeout(() => process.exit(0), 60000)", "{prompt}"],
  });
  const result = await runWith(hung, {
    HARNESS_AGENT_IDLE_TIMEOUT_MS: "600",
    HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "30000",
  });
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /no output for 600ms/);
});

test("an abandoned call does not shield an agent that has already finished its turn", async () => {
  // Codex's real shape: a command is started and never closed, the turn
  // completes, and then the process lingers. That is the hang the idle limit
  // exists for, so it must still stop at the idle limit, not the tool budget.
  const started = JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "sleep 40" } });
  const turnDone = JSON.stringify({ type: "turn.completed", usage: { output_tokens: 1 } });
  const lingering = new CommandAgentProvider({
    provider: "command",
    command: process.execPath,
    args: [
      "-e",
      `console.log(${JSON.stringify(started)}); console.log(${JSON.stringify(turnDone)}); setTimeout(() => process.exit(0), 60000);`,
      "{prompt}",
    ],
  });
  const result = await runWith(lingering, {
    HARNESS_AGENT_IDLE_TIMEOUT_MS: "600",
    HARNESS_AGENT_TOOL_IDLE_TIMEOUT_MS: "30000",
  });
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /no output for 600ms/);
});
