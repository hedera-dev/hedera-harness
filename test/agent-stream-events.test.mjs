import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { AgentStreamLogger, summarizeStreamEvent } = await import(
  pathToFileURL(path.resolve("dist/agentStreamLogger.js")).href
);

/**
 * Fixtures below are trimmed from real `--output-format stream-json` output.
 *
 * The two CLIs share only the `system` and `result` envelopes, so a parser that
 * understands one is silently blind to the other: before this was fixed, every
 * `agent: claude` run reported `0` tool calls for its entire duration.
 */

function claudeAssistant(...blocks) {
  return {
    type: "assistant",
    session_id: "claude-session",
    message: { id: "msg_1", role: "assistant", content: blocks },
  };
}

function claudeToolResults(...blocks) {
  return { type: "user", session_id: "claude-session", message: { role: "user", content: blocks } };
}

function cursorToolCall(subtype, toolCall) {
  return { type: "tool_call", subtype, session_id: "cursor-session", tool_call: toolCall };
}

// ── Claude Code wire format ──────────────────────────────────────────────────

test("claude tool_use blocks are summarized and counted", () => {
  const summary = summarizeStreamEvent(
    claudeAssistant({
      type: "tool_use",
      id: "toolu_1",
      name: "Edit",
      input: { file_path: "packages/nextjs/app/page.tsx" },
    }),
  );

  assert.equal(summary.summary, "TOOL START edit packages/nextjs/app/page.tsx");
  assert.equal(summary.toolCallsStarted, 1);
});

test("claude parallel tool calls on one message count individually", () => {
  const summary = summarizeStreamEvent(
    claudeAssistant(
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "b.ts" } },
      { type: "tool_use", id: "t3", name: "Grep", input: { pattern: "TODO" } },
    ),
  );

  // Counting one per event would under-report a parallel turn by two.
  assert.equal(summary.toolCallsStarted, 3);
  assert.equal(summary.summary, "TOOL START read a.ts (+2 more)");
});

test("claude tool names map onto the same vocabulary as cursor", () => {
  const cases = [
    [{ name: "Write", input: { file_path: "x.ts" } }, "TOOL START write x.ts"],
    [{ name: "Read", input: { file_path: "y.ts" } }, "TOOL START read y.ts"],
    [{ name: "Bash", input: { command: "yarn build" } }, "TOOL START shell yarn build"],
    [{ name: "PowerShell", input: { command: "yarn lint" } }, "TOOL START shell yarn lint"],
    [{ name: "Glob", input: { pattern: "**/*.sol" } }, "TOOL START glob **/*.sol"],
    [{ name: "Task", input: { description: "audit contracts" } }, "TOOL START task audit contracts"],
  ];

  for (const [block, expected] of cases) {
    const summary = summarizeStreamEvent(claudeAssistant({ type: "tool_use", id: "t", ...block }));
    assert.equal(summary.summary, expected);
  }
});

test("claude mcp tools fall through to a generic description", () => {
  const summary = summarizeStreamEvent(
    claudeAssistant({
      type: "tool_use",
      id: "t",
      name: "mcp__playwright__browser_navigate",
      input: { url: "http://localhost:3000" },
    }),
  );

  assert.match(summary.summary, /^TOOL START mcp__playwright__browser_navigate /);
  assert.match(summary.summary, /localhost:3000/);
  assert.equal(summary.toolCallsStarted, 1);
});

test("claude tool_result blocks close the calls they answer", () => {
  const summary = summarizeStreamEvent(
    claudeToolResults(
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true },
    ),
  );

  assert.equal(summary.toolCallsCompleted, 2);
  assert.equal(summary.summary, "TOOL DONE 2 result(s) (1 error)");
});

test("claude prose and thinking turns are logged but never counted as tools", () => {
  const prose = summarizeStreamEvent(
    claudeAssistant({ type: "text", text: "Reading the recipe before editing." }),
  );
  assert.equal(prose.summary, "TEXT Reading the recipe before editing.");
  assert.equal(prose.toolCallsStarted, undefined);

  const thinking = summarizeStreamEvent(
    claudeAssistant({ type: "thinking", thinking: "considering the failure" }),
  );
  assert.equal(thinking.summary, "THINKING completed");
  assert.equal(thinking.toolCallsStarted, undefined);
});

test("a claude user message that carries no tool results is not activity", () => {
  assert.equal(summarizeStreamEvent(claudeToolResults({ type: "text", text: "hi" })), null);
  // The initial prompt echo arrives as a plain string rather than blocks.
  assert.equal(
    summarizeStreamEvent({ type: "user", message: { role: "user", content: "the prompt" } }),
    null,
  );
});

// ── Cursor CLI wire format (must not regress) ────────────────────────────────

test("cursor tool_call events keep their summaries and counts", () => {
  const started = summarizeStreamEvent(
    cursorToolCall("started", { editToolCall: { args: { path: "app/page.tsx" } } }),
  );
  assert.equal(started.summary, "TOOL START edit app/page.tsx");
  assert.equal(started.toolCallsStarted, 1);
  assert.equal(started.toolCallsCompleted, undefined);

  const completed = summarizeStreamEvent(
    cursorToolCall("completed", { shellToolCall: { args: { command: "yarn next:build" } } }),
  );
  assert.equal(completed.summary, "TOOL DONE shell yarn next:build");
  assert.equal(completed.toolCallsCompleted, 1);
  assert.equal(completed.toolCallsStarted, undefined);
});

test("cursor tool payload variants still resolve", () => {
  const cases = [
    [{ readToolCall: { args: { path: "a.ts" } } }, "TOOL START read a.ts"],
    [{ grepToolCall: { args: { pattern: "TODO" } } }, "TOOL START grep TODO"],
    [{ globToolCall: { args: { globPattern: "**/*.ts" } } }, "TOOL START glob **/*.ts"],
    [{ deleteToolCall: { args: { path: "old.ts" } } }, "TOOL START delete old.ts"],
    [
      { runTerminalCommandToolCall: { args: { command: "yarn lint" } } },
      "TOOL START shell yarn lint",
    ],
  ];

  for (const [toolCall, expected] of cases) {
    assert.equal(summarizeStreamEvent(cursorToolCall("started", toolCall)).summary, expected);
  }

  assert.equal(summarizeStreamEvent(cursorToolCall("started", null)).summary, "TOOL START");
});

// ── Shared envelopes ─────────────────────────────────────────────────────────

test("shared system and result envelopes are unchanged", () => {
  assert.equal(
    summarizeStreamEvent({ type: "system", subtype: "init", model: "opus" }).summary,
    "SESSION started model=opus",
  );
  assert.equal(
    summarizeStreamEvent({ type: "result", subtype: "success", duration_ms: 1500 }).summary,
    "RESULT success durationMs=1500",
  );
  assert.equal(
    summarizeStreamEvent({ type: "result", subtype: "idle_timeout", is_error: true }).summary,
    "RESULT idle_timeout error",
  );
  assert.equal(summarizeStreamEvent({ type: "rate_limit_event" }), null);
});

// ── End to end through the logger ────────────────────────────────────────────

test("a claude transcript advances progress and reaches the activity log", async () => {
  const dir = await makeOsTempDir("harness-stream-");
  const activityLogPath = path.join(dir, "activity.log");
  const progressUpdates = [];

  const logger = new AgentStreamLogger(activityLogPath, progress =>
    progressUpdates.push({ ...progress }),
  );
  await logger.initialize();

  const transcript = [
    // Claude opens with a rate-limit envelope that carries no activity summary.
    { type: "rate_limit_event", session_id: "claude-session" },
    { type: "system", subtype: "init", session_id: "claude-session", model: "opus" },
    claudeAssistant({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "spec.yaml" } }),
    claudeToolResults({ type: "tool_result", tool_use_id: "t1", content: "..." }),
    claudeAssistant(
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "page.tsx" } },
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "layout.tsx" } },
    ),
    claudeToolResults(
      { type: "tool_result", tool_use_id: "t2", content: "ok" },
      { type: "tool_result", tool_use_id: "t3", content: "ok" },
    ),
    { type: "result", subtype: "success", session_id: "claude-session", duration_ms: 42 },
  ];

  // Split mid-line to prove the buffer reassembles across chunk boundaries.
  const raw = transcript.map(event => JSON.stringify(event)).join("\n") + "\n";
  await logger.processChunk(raw.slice(0, 137));
  await logger.processChunk(raw.slice(137));

  const progress = logger.getProgress();
  assert.equal(progress.toolCallsStarted, 3, "three tool calls were issued");
  assert.equal(progress.toolCallsCompleted, 3, "three results came back");
  assert.equal(progress.sessionId, "claude-session");
  assert.equal(progress.lastActivity, "RESULT success durationMs=42");
  assert.ok(progressUpdates.length > 0, "progress callback fires for the status file");

  const log = await readFile(activityLogPath, "utf8");
  assert.match(log, /SESSION started model=opus/);
  assert.match(log, /TOOL START read spec\.yaml/);
  assert.match(log, /TOOL START edit page\.tsx \(\+1 more\)/);
  assert.match(log, /TOOL DONE 2 result\(s\)/);
});

test("a cursor transcript still advances progress", async () => {
  const dir = await makeOsTempDir("harness-stream-");
  const logger = new AgentStreamLogger(path.join(dir, "activity.log"));
  await logger.initialize();

  for (const event of [
    { type: "system", subtype: "init", session_id: "cursor-session", model: "composer-2.5" },
    cursorToolCall("started", { editToolCall: { args: { path: "a.ts" } } }),
    cursorToolCall("completed", { editToolCall: { args: { path: "a.ts" } } }),
    { type: "thinking", subtype: "completed" },
  ]) {
    await logger.processChunk(`${JSON.stringify(event)}\n`);
  }

  const progress = logger.getProgress();
  assert.equal(progress.toolCallsStarted, 1);
  assert.equal(progress.toolCallsCompleted, 1);
  assert.equal(progress.sessionId, "cursor-session");
  assert.equal(progress.lastActivity, "THINKING completed");
});

test("session id is captured even from an event with no activity summary", async () => {
  const dir = await makeOsTempDir("harness-stream-");
  const logger = new AgentStreamLogger(path.join(dir, "activity.log"));
  await logger.initialize();

  await logger.processChunk(
    `${JSON.stringify({ type: "rate_limit_event", session_id: "early-session" })}\n`,
  );

  assert.equal(logger.getProgress().sessionId, "early-session");
});

test("malformed and empty lines are skipped without disturbing progress", async () => {
  const dir = await makeOsTempDir("harness-stream-");
  const logger = new AgentStreamLogger(path.join(dir, "activity.log"));
  await logger.initialize();

  await logger.processChunk("not json\n\n{\"type\":\"nope\"}\n");

  assert.equal(logger.getProgress().lastActivity, "waiting for agent output");
  assert.equal(logger.getProgress().toolCallsStarted, 0);
});
