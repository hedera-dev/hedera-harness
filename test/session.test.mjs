import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { makeTestTempDir } from "./tmpDir.mjs";

const sessionMod = await import(pathToFileURL(path.resolve("dist/session.js")).href);
const gitMod = await import(pathToFileURL(path.resolve("dist/harnessGit.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function writeMinimalRecipe(root) {
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# PRD\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "[]\n");
  await writeFile(path.join(root, ".harness", "validators", "commands.json"), "[]\n");
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: demo-extend
description: session fixture
prd: .harness/prd.md
generator:
  provider: command
  command: agent
baseline:
  commands:
      - name: install
        command: yarn install
        timeoutMs: 300000
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/commands.json
requiredFiles: []
forbiddenFiles: []
maxAttempts: 2
constraints:
  packageManager: yarn
`,
  );
}

async function initExtendFixture() {
  const root = await makeTestTempDir("extend-session-");
  git(root, ["init", "--template="]);
  git(root, ["config", "user.email", "harness-test@example.com"]);
  git(root, ["config", "user.name", "Harness Test"]);
  await writeMinimalRecipe(root);
  await writeFile(path.join(root, "README.md"), "# app\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "init recipe"]);
  if (!git(root, ["branch", "--show-current"])) {
    git(root, ["checkout", "-b", "master"]);
  }
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"), {

  });
  return { root, loaded };
}

test("normal branch start requires clean tree, creates harness branch + session metadata", async () => {
  const { root, loaded } = await initExtendFixture();
  const baseBranch = git(root, ["branch", "--show-current"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);

  const prepared = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });

  assert.equal(prepared.mode, "start");
  assert.equal(prepared.startingAttempt, 1);
  assert.equal(prepared.cycle, undefined);
  assert.match(prepared.session.branch, /^harness\/run-demo-extend-[a-f0-9]+$/);
  assert.equal(prepared.session.baseBranch, baseBranch);
  assert.equal(prepared.session.baseSha, baseSha);
  assert.equal(prepared.session.lastCheckpointSha, git(root, ["rev-parse", "HEAD"]));
  assert.equal(git(root, ["branch", "--show-current"]), prepared.session.branch);

  const raw = JSON.parse(
    await readFile(path.join(prepared.layout.runDirectory, "session.json"), "utf8"),
  );
  assert.equal(raw.schemaVersion, 1);
  assert.equal(raw.specSlug, "demo-extend");
  assert.equal(raw.gateStatus, "pending");
});

test("dirty normal branch is refused before branch creation", async () => {
  const { root, loaded } = await initExtendFixture();
  await writeFile(path.join(root, "extra.txt"), "dirty\n");

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.match(error.message, /clean working tree/i);
      assert.equal(gitMod.isHarnessBranch(git(root, ["branch", "--show-current"])), false);
      return true;
    },
  );
});

test("harness branch with matching session continues without nested branch", async () => {
  const { root, loaded } = await initExtendFixture();
  const first = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });
  const branch = first.session.branch;

  // Simulate a completed attempt checkpoint at current HEAD.
  await sessionMod.recordCheckpoint({
    runDirectory: first.layout.runDirectory,
    attempt: 2,
    checkpointSha: git(root, ["rev-parse", "HEAD"]),
    gateStatus: "failed",
  });

  const continued = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });

  assert.equal(continued.mode, "continue");
  assert.equal(continued.session.branch, branch);
  assert.equal(git(root, ["branch", "--show-current"]), branch);
  assert.equal(continued.startingAttempt, 3);
  assert.equal(continued.cycle, 1);
  assert.equal(continued.layout.runDirectory, first.layout.runDirectory);
});

test("interrupted dirty recovery refuses continue and does not auto-commit", async () => {
  const { root, loaded } = await initExtendFixture();
  const first = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });
  await sessionMod.recordCheckpoint({
    runDirectory: first.layout.runDirectory,
    attempt: 1,
    checkpointSha: git(root, ["rev-parse", "HEAD"]),
  });

  await writeFile(path.join(root, "packages-app.ts"), "export const x = 1;\n");

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "interrupted-dirty");
      assert.match(error.message, /uncommitted consumer changes/i);
      assert.match(error.message, /will not auto-commit/i);
      assert.match(error.message, /packages-app\.ts/);
      // Still on the same harness branch; no nested branch created.
      assert.equal(git(root, ["branch", "--show-current"]), first.session.branch);
      return true;
    },
  );
});

test("same-spec harness branch without session metadata is refused", async () => {
  const { root, loaded } = await initExtendFixture();
  // Same slug as fixture spec name `demo-extend`, but no session.json → refuse continue.
  git(root, ["checkout", "-b", "harness/run-demo-extend-deadbeef"]);

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "unknown-harness-branch");
      assert.match(error.message, /no matching local session metadata/i);
      return true;
    },
  );
});

test("different-spec on harness branch starts a new harness/run-* branch", async () => {
  const { root, loaded } = await initExtendFixture();
  const first = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });

  // Rewrite recipe to a different feature name while staying on the first harness branch.
  // Commit so the tree is clean (start requires a clean working tree).
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: other-feature
prd: .harness/prd.md
generator:
  provider: command
  command: agent
baseline:
  commands:
      - name: install
        command: yarn install
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/commands.json
requiredFiles: []
forbiddenFiles: []
constraints:
  packageManager: yarn
`,
  );
  git(root, ["add", ".harness/spec.yaml"]);
  git(root, ["commit", "-m", "switch to other-feature recipe"]);

  const other = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"), {

  });

  const prepared = await sessionMod.prepareSession({
    workspacePath: root,
    loaded: other,
    skipToolChecks: true,
    skipBaseline: true,
  });

  assert.equal(prepared.mode, "start");
  assert.match(prepared.session.branch, /^harness\/run-other-feature-[a-f0-9]+$/);
  assert.notEqual(prepared.session.branch, first.session.branch);
  assert.equal(git(root, ["branch", "--show-current"]), prepared.session.branch);
});

test("--new forces a fresh harness branch even on a matching session branch", async () => {
  const { root, loaded } = await initExtendFixture();
  const first = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });
  await sessionMod.recordCheckpoint({
    runDirectory: first.layout.runDirectory,
    attempt: 1,
    checkpointSha: git(root, ["rev-parse", "HEAD"]),
    gateStatus: "failed",
  });

  const prepared = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
    forceNew: true,
  });

  assert.equal(prepared.mode, "start");
  assert.match(prepared.session.branch, /^harness\/run-demo-extend-[a-f0-9]+$/);
  assert.notEqual(prepared.session.branch, first.session.branch);
});

test("checkpoint mismatch refuses continue when HEAD moved", async () => {
  const { root, loaded } = await initExtendFixture();
  const first = await sessionMod.prepareSession({
    workspacePath: root,
    loaded,
    skipToolChecks: true,
    skipBaseline: true,
  });
  await sessionMod.recordCheckpoint({
    runDirectory: first.layout.runDirectory,
    attempt: 1,
    checkpointSha: git(root, ["rev-parse", "HEAD"]),
  });

  await writeFile(path.join(root, "manual.ts"), "export {}\n");
  git(root, ["add", "manual.ts"]);
  git(root, ["commit", "-m", "user commit"]);

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "checkpoint-mismatch");
      assert.match(error.message, /lastCheckpointSha/);
      return true;
    },
  );
});

test("merge in progress fails read-only preflight", async () => {
  const { root, loaded } = await initExtendFixture();
  // Create a second commit and a conflicting branch to start a merge.
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  git(root, ["add", "conflict.txt"]);
  git(root, ["commit", "-m", "conflict base"]);
  git(root, ["checkout", "-b", "other"]);
  await writeFile(path.join(root, "conflict.txt"), "other\n");
  git(root, ["add", "conflict.txt"]);
  git(root, ["commit", "-m", "other"]);
  git(root, ["checkout", "-"]);
  await writeFile(path.join(root, "conflict.txt"), "mainline\n");
  git(root, ["add", "conflict.txt"]);
  git(root, ["commit", "-m", "mainline"]);
  const merge = spawnSync("git", ["merge", "other"], { cwd: root, encoding: "utf8" });
  assert.notEqual(merge.status, 0);

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "git-operation-in-progress");
      assert.match(error.message, /merge/i);
      return true;
    },
  );
});
