import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { CommandAgentProvider } = await import(
  pathToFileURL(path.resolve("dist/providers/commandAgentProvider.js")).href
);

/**
 * An agent that prints its whole stream and exits at once, so the `close`
 * event follows the final `result` line as closely as a real CLI ever does.
 */
const FAST_EXIT_AGENT = `
const line = value => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", model: "mock", session_id: "sess-1" });
line({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "README.md" } } } });
line({ type: "tool_call", subtype: "completed", tool_call: { readToolCall: { args: { path: "README.md" } } } });
line({ type: "result", subtype: "success", is_error: false, duration_ms: 10 });
`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runFastExitAgent() {
  const root = await makeTestTempDir("agent-stream-close-");
  await mkdir(path.join(root, "logs"), { recursive: true });
  await writeFile(path.join(root, "agent.mjs"), FAST_EXIT_AGENT);

  const activities = [];
  const provider = new CommandAgentProvider({ command: process.execPath, args: ["agent.mjs"] });
  const logPath = path.join(root, "logs", "agent.log");
  const activityLogPath = path.join(root, "logs", "agent-activity.log");

  const result = await provider.run({
    prompt: "do the thing",
    workspacePath: root,
    logPath,
    activityLogPath,
    // Every stream line costs a few ms to record, as it does when the harness
    // writes status.json from onProgress. The agent exits far quicker than that.
    onProgress: async progress => {
      await sleep(15);
      activities.push(progress.lastActivity);
    },
  });
  const settledAt = activities.length;
  // Anything still being parsed after run() resolved would land here.
  await sleep(150);

  return {
    result,
    activities,
    settledAt,
    rawLog: await readFile(logPath, "utf8"),
    activityLog: await readFile(activityLogPath, "utf8"),
  };
}

test("the final result line is parsed before the agent run resolves", async () => {
  const { result, activities, settledAt, rawLog } = await runFastExitAgent();

  assert.equal(result.exitCode, 0);
  assert.equal(activities.at(-1), "RESULT success durationMs=10");
  assert.equal(settledAt, activities.length, "no stream line may be processed after run() resolved");
  assert.match(rawLog, /lastActivity=RESULT success durationMs=10\n/);
  assert.match(rawLog, /toolCallsStarted=1\n/);
  assert.match(rawLog, /toolCallsCompleted=1\n/);
  assert.match(rawLog, /sessionId=sess-1\n/);
});

test("the activity log keeps the order the agent printed in", async () => {
  const { activities, activityLog } = await runFastExitAgent();

  assert.deepEqual(activities, [
    "SESSION started model=mock",
    "TOOL START read README.md",
    "TOOL DONE read README.md",
    "RESULT success durationMs=10",
  ]);
  const logged = activityLog
    .split("\n")
    .filter(line => line && !line.startsWith("#"))
    .map(line => line.replace(/^\S+ /, ""));
  assert.deepEqual(logged, activities);
});
