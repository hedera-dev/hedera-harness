import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("refactored modules export the shared attempt loop and both runners", async () => {
  const attemptLoop = await import(pathToFileURL(path.resolve("dist/attemptLoop.js")).href);
  const runner = await import(pathToFileURL(path.resolve("dist/runner.js")).href);
  const sessionRunner = await import(pathToFileURL(path.resolve("dist/sessionRunner.js")).href);
  const session = await import(pathToFileURL(path.resolve("dist/session.js")).href);
  const harnessGit = await import(pathToFileURL(path.resolve("dist/harnessGit.js")).href);
  const runCleanup = await import(pathToFileURL(path.resolve("dist/runCleanup.js")).href);
  const runOutro = await import(pathToFileURL(path.resolve("dist/runOutro.js")).href);
  const initRunner = await import(pathToFileURL(path.resolve("dist/initRunner.js")).href);
  const branchDetection = await import(pathToFileURL(path.resolve("dist/branchDetection.js")).href);
  const provisioner = await import(pathToFileURL(path.resolve("dist/harnessProvisioner.js")).href);

  assert.equal(typeof attemptLoop.runAttemptLoop, "function");
  assert.equal(typeof attemptLoop.runSessionAttemptLoop, "function");
  assert.equal(typeof attemptLoop.createSessionPromptStrategy, "function");
  assert.equal(typeof attemptLoop.runAttemptValidation, "function");
  assert.equal(typeof runner.runHarness, "function");
  assert.equal(typeof runner.validateWorkspace, "function");
  assert.equal(typeof runner.validateSemanticWorkspace, "function");
  assert.equal(typeof sessionRunner.runSession, "function");
  assert.equal(typeof session.prepareSession, "function");
  assert.equal(typeof harnessGit.createAndCheckoutHarnessBranch, "function");
  assert.equal(typeof harnessGit.commitAttempt, "function");
  assert.equal(typeof runCleanup.cleanupRuntimeInjections, "function");
  assert.equal(typeof runOutro.formatRunOutro, "function");
  assert.equal(typeof initRunner.runInit, "function");
  assert.equal(typeof branchDetection.decideBranchAction, "function");
  assert.equal(typeof branchDetection.parseHarnessBranch, "function");
  assert.equal(typeof provisioner.provisionHarnessProject, "function");
});
