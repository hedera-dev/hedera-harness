import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("refactored modules export the shared attempt loop and both runners", async () => {
  const attemptLoop = await import(pathToFileURL(path.resolve("dist/attemptLoop.js")).href);
  const runner = await import(pathToFileURL(path.resolve("dist/runner.js")).href);
  const extendRunner = await import(pathToFileURL(path.resolve("dist/extendRunner.js")).href);

  assert.equal(typeof attemptLoop.runAttemptLoop, "function");
  assert.equal(typeof attemptLoop.runAttemptValidation, "function");
  assert.equal(typeof runner.runHarness, "function");
  assert.equal(typeof runner.validateWorkspace, "function");
  assert.equal(typeof runner.validateSemanticWorkspace, "function");
  assert.equal(typeof extendRunner.runExtend, "function");
});
