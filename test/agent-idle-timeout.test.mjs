import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  DEFAULT_AGENT_IDLE_TIMEOUT_MS,
  readAgentIdleTimeoutMs,
} = await import(pathToFileURL(path.resolve("dist/providers/commandAgentProvider.js")).href);

test("default agent idle timeout is 90s", () => {
  assert.equal(DEFAULT_AGENT_IDLE_TIMEOUT_MS, 90_000);
  assert.equal(readAgentIdleTimeoutMs({}), 90_000);
});

test("HARNESS_AGENT_IDLE_TIMEOUT_MS overrides idle timeout", () => {
  assert.equal(readAgentIdleTimeoutMs({ HARNESS_AGENT_IDLE_TIMEOUT_MS: "45000" }), 45_000);
  assert.equal(readAgentIdleTimeoutMs({ HARNESS_AGENT_IDLE_TIMEOUT_MS: "0" }), 90_000);
  assert.equal(readAgentIdleTimeoutMs({ HARNESS_AGENT_IDLE_TIMEOUT_MS: "nope" }), 90_000);
});
