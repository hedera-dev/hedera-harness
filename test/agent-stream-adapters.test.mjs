import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { AgentStreamLogger, interpretStreamEvent } = await import(
  pathToFileURL(path.resolve("dist/agentStreamLogger.js")).href
);

/** Replay a captured CLI stream through the logger exactly as the provider does. */
async function replay(fixture) {
  const raw = await readFile(path.resolve("test/fixtures/streams", fixture), "utf8");
  const root = await makeTestTempDir("stream-");
  const logPath = path.join(root, "activity.log");
  const logger = new AgentStreamLogger(logPath);
  await logger.initialize();
  // Split mid-line to prove the buffer reassembles across chunk boundaries.
  const cut = Math.floor(raw.length / 2);
  await logger.processChunk(raw.slice(0, cut));
  await logger.processChunk(raw.slice(cut));
  return { progress: logger.getProgress(), log: await readFile(logPath, "utf8") };
}

test("claude tool calls are counted (they are content blocks, not events)", async () => {
  const { progress, log } = await replay("claude-code.jsonl");

  // Regression: the logger only understood Cursor's `tool_call` event, so the
  // default agent reported zero tool calls for an entire run.
  assert.equal(progress.toolCallsStarted, 1, "the captured run makes one Bash call");
  assert.equal(progress.toolCallsCompleted, 1, "and one tool_result comes back");
  assert.ok(progress.sessionId, "session id comes off the init event");
  assert.match(log, /TOOL START Bash\(echo harness-probe\)/);
  assert.match(log, /TOOL DONE 1 result/);
});

test("codex thread/turn/item events map onto the same vocabulary", async () => {
  const { progress, log } = await replay("codex-exec.jsonl");

  // shell + file edit + one MCP call, each with a started/completed pair.
  assert.equal(progress.toolCallsStarted, 3);
  assert.equal(progress.toolCallsCompleted, 3);
  assert.ok(progress.sessionId, "thread_id is the session id");
  assert.match(log, /TOOL START shell \/bin\/zsh -lc 'echo harness-probe'/);
  assert.match(log, /TOOL DONE shell .* exit=0/);
  assert.match(log, /TOOL (START|DONE) edit \/workspace\/probe\.txt/);
  assert.match(log, /TOOL START mcp playwright\.browser_navigate/);
  assert.match(log, /RESULT success/);
});

test("codex narration is reported but never counted as a tool call", () => {
  const message = interpretStreamEvent({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "Done." },
  });
  assert.equal(message.summary, "MESSAGE Done.");
  assert.equal(message.toolCallsStarted ?? 0, 0);
  assert.equal(message.toolCallsCompleted ?? 0, 0);

  const failure = interpretStreamEvent({
    type: "turn.failed",
    error: { message: "model not supported" },
  });
  assert.match(failure.summary, /RESULT failed error model not supported/);
});

test("cursor events keep their existing summaries", () => {
  assert.equal(
    interpretStreamEvent({ type: "system", subtype: "init", model: "composer-2.5" }).summary,
    "SESSION started model=composer-2.5",
  );

  const shell = interpretStreamEvent({
    type: "tool_call",
    subtype: "started",
    tool_call: { shellToolCall: { args: { command: "yarn build" } } },
  });
  assert.equal(shell.summary, "TOOL START shell yarn build");
  assert.equal(shell.toolCallsStarted, 1);

  const edit = interpretStreamEvent({
    type: "tool_call",
    subtype: "completed",
    tool_call: { editToolCall: { args: { path: "app/page.tsx" } } },
  });
  assert.equal(edit.summary, "TOOL DONE edit app/page.tsx");
  assert.equal(edit.toolCallsCompleted, 1);

  assert.equal(
    interpretStreamEvent({ type: "thinking", subtype: "completed" }).summary,
    "THINKING completed",
  );
});

test("unknown events and malformed lines are ignored, not crashed on", async () => {
  assert.equal(interpretStreamEvent({ type: "rate_limit_event" }), null);
  assert.equal(interpretStreamEvent({}), null);

  const root = await makeTestTempDir("stream-junk-");
  const logger = new AgentStreamLogger(path.join(root, "activity.log"));
  await logger.initialize();
  await logger.processChunk("not json\n{\n\n");
  assert.equal(logger.getProgress().toolCallsStarted, 0);
});

test("a command Codex never closes stops counting as in flight when the turn ends", async () => {
  // Captured: Codex started `sleep 40`, moved on, wrote a file, completed the
  // turn, and never emitted item.completed for the command.
  const raw = await readFile(path.resolve("test/fixtures/streams/codex-unclosed-command.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  const commandStart = lines.findIndex(
    line => line.includes('"item.started"') && line.includes('"command_execution"'),
  );
  assert.ok(commandStart >= 0, "fixture must contain the unclosed command");

  const root = await makeTestTempDir("stream-unclosed-");
  const logger = new AgentStreamLogger(path.join(root, "activity.log"));
  await logger.initialize();

  await logger.processChunk(`${lines.slice(0, commandStart + 1).join("\n")}\n`);
  assert.equal(logger.hasToolCallInFlight(), true, "while the command runs, it is in flight");

  await logger.processChunk(`${lines.slice(commandStart + 1).join("\n")}\n`);
  assert.equal(logger.hasToolCallInFlight(), false, "turn.completed closes what was left open");
  assert.ok(
    logger.getProgress().toolCallsStarted > logger.getProgress().toolCallsCompleted,
    "the reported counters still show the call Codex never closed",
  );
});
