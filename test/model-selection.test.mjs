import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { selectModel, withModel } = await import(
  pathToFileURL(path.resolve("dist/modelSelection.js")).href
);
const { AGENT_PRESETS } = await import(pathToFileURL(path.resolve("dist/specDefaults.js")).href);

const claude = { agent: "claude" };
const strong = AGENT_PRESETS.claude.defaultModel;
const cheap = AGENT_PRESETS.claude.repairModel;

/** Env knobs are process-global; restore whatever the runner had. */
function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("the first attempt of a cycle uses the strong model", () => {
  const choice = selectModel({
    spec: claude,
    isFirstAttemptOfCycle: true,
    previousFixedCount: 0,
    hasRepaired: false,
  });
  assert.equal(choice.model, strong);
  assert.equal(choice.reason, "first-attempt");
});

test("a repair after real progress uses the cheaper model", () => {
  const choice = selectModel({
    spec: claude,
    isFirstAttemptOfCycle: false,
    previousFixedCount: 2,
    hasRepaired: true,
  });
  assert.equal(choice.model, cheap);
  assert.equal(choice.reason, "repair");
});

test("a repair after zero progress escalates back to the strong model", () => {
  // Paying less to repeat a failure is not a saving.
  const choice = selectModel({
    spec: claude,
    isFirstAttemptOfCycle: false,
    previousFixedCount: 0,
    hasRepaired: true,
  });
  assert.equal(choice.model, strong);
  assert.equal(choice.reason, "escalated");
});

test("env vars override both models", () => {
  withEnv({ HARNESS_MODEL: "big", HARNESS_FIX_MODEL: "small" }, () => {
    assert.equal(
      selectModel({ spec: claude, isFirstAttemptOfCycle: true, previousFixedCount: 0, hasRepaired: false }).model,
      "big",
    );
    assert.equal(
      selectModel({ spec: claude, isFirstAttemptOfCycle: false, previousFixedCount: 1, hasRepaired: true }).model,
      "small",
    );
  });
});

test("escalation can be disabled", () => {
  withEnv({ HARNESS_NO_MODEL_SWITCH: "1" }, () => {
    const choice = selectModel({
      spec: claude,
      isFirstAttemptOfCycle: false,
      previousFixedCount: 5,
      hasRepaired: true,
    });
    assert.equal(choice.model, strong, "every attempt should use the strong model");
  });
});

test("withModel replaces an existing flag value rather than duplicating it", () => {
  const config = { provider: "command", command: "claude", args: ["-p", "--model", "opus", "-v"] };
  const updated = withModel(config, "--model", "sonnet");

  assert.deepEqual(updated.args, ["-p", "--model", "sonnet", "-v"]);
  assert.equal(updated.args.filter(a => a === "--model").length, 1);
  assert.deepEqual(config.args, ["-p", "--model", "opus", "-v"], "input must not be mutated");
});

test("withModel appends when the flag is last", () => {
  const updated = withModel({ provider: "command", command: "x", args: ["--model"] }, "--model", "m");
  assert.deepEqual(updated.args, ["--model", "m"]);
});

test("withModel leaves a hand-written invocation alone", () => {
  // Someone who wrote their own generator block owns its flags.
  const config = { provider: "command", command: "my-wrapper", args: ["--go"] };
  assert.deepEqual(withModel(config, "--model", "sonnet").args, ["--go"]);
});
