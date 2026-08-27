import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const mod = await import(pathToFileURL(path.resolve("dist/branchDetection.js")).href);

test("parseHarnessBranch reads harness/run- prefixes only", () => {
  const run = mod.parseHarnessBranch("harness/run-my-feature-abc123");
  assert.deepEqual(run, {
    specSlug: "my-feature",
    shortId: "abc123",
    branch: "harness/run-my-feature-abc123",
  });

  assert.equal(mod.parseHarnessBranch("harness/extend-bridge-page-dead01"), null);
  assert.equal(mod.parseHarnessBranch("main"), null);
  assert.equal(mod.parseHarnessBranch("harness/run-only"), null);
});

test("decideBranchAction continues on matching harness branch", () => {
  const decision = mod.decideBranchAction({
    currentBranch: "harness/run-my-feature-abc123",
    specName: "my-feature",
  });
  assert.equal(decision.action, "continue");
});

test("decideBranchAction creates new branch for different spec", () => {
  const decision = mod.decideBranchAction({
    currentBranch: "harness/run-my-feature-abc123",
    specName: "other-feature",
  });
  assert.equal(decision.action, "new");
});

test("decideBranchAction creates new branch on main", () => {
  const decision = mod.decideBranchAction({
    currentBranch: "main",
    specName: "my-feature",
  });
  assert.equal(decision.action, "new");
});

test("decideBranchAction honors --new and --continue overrides", () => {
  assert.equal(
    mod.decideBranchAction({
      currentBranch: "harness/run-my-feature-abc123",
      specName: "my-feature",
      forceNew: true,
    }).action,
    "new",
  );
  assert.equal(
    mod.decideBranchAction({
      currentBranch: "main",
      specName: "my-feature",
      continueBranch: "harness/run-my-feature-abc123",
    }).action,
    "continue",
  );
});

test("buildRunBranchName uses harness/run- prefix", () => {
  assert.equal(mod.buildRunBranchName("My Feature!", "abc123"), "harness/run-my-feature-abc123");
});
