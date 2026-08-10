import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("refactored modules export the shared attempt loop and both runners", async () => {
  const attemptLoop = await import(pathToFileURL(path.resolve("dist/attemptLoop.js")).href);
  const runner = await import(pathToFileURL(path.resolve("dist/runner.js")).href);
  const extendRunner = await import(pathToFileURL(path.resolve("dist/extendRunner.js")).href);
  const extendSession = await import(pathToFileURL(path.resolve("dist/extendSession.js")).href);
  const extendGit = await import(pathToFileURL(path.resolve("dist/extendGit.js")).href);
  const extendCleanup = await import(pathToFileURL(path.resolve("dist/extendCleanup.js")).href);
  const extendOutro = await import(pathToFileURL(path.resolve("dist/extendOutro.js")).href);
  const initRunner = await import(pathToFileURL(path.resolve("dist/initRunner.js")).href);
  const branchDetection = await import(pathToFileURL(path.resolve("dist/branchDetection.js")).href);
  const provisioner = await import(pathToFileURL(path.resolve("dist/harnessProvisioner.js")).href);

  assert.equal(typeof attemptLoop.runAttemptLoop, "function");
  assert.equal(typeof attemptLoop.runIsolatedAttemptLoop, "function");
  assert.equal(typeof attemptLoop.runExtendAttemptLoop, "function");
  assert.equal(typeof attemptLoop.createIsolatedPromptStrategy, "function");
  assert.equal(typeof attemptLoop.createExtendPromptStrategy, "function");
  assert.equal(typeof attemptLoop.runAttemptValidation, "function");
  assert.equal(typeof runner.runHarness, "function");
  assert.equal(typeof runner.runProjectHarness, "function");
  assert.equal(typeof runner.validateWorkspace, "function");
  assert.equal(typeof runner.validateSemanticWorkspace, "function");
  assert.equal(typeof extendRunner.runExtend, "function");
  assert.equal(typeof extendSession.prepareExtendSession, "function");
  assert.equal(typeof extendGit.createAndCheckoutExtendBranch, "function");
  assert.equal(typeof extendGit.commitExtendAttempt, "function");
  assert.equal(typeof extendCleanup.cleanupExtendRuntimeInjections, "function");
  assert.equal(typeof extendOutro.formatExtendOutro, "function");
  assert.equal(typeof initRunner.runInit, "function");
  assert.equal(typeof branchDetection.decideBranchAction, "function");
  assert.equal(typeof branchDetection.parseHarnessBranch, "function");
  assert.equal(typeof provisioner.provisionHarnessProject, "function");
});
