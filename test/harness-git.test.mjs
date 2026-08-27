import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { makeTestTempDir } from "./tmpDir.mjs";

const gitMod = await import(pathToFileURL(path.resolve("dist/harnessGit.js")).href);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function initRepo() {
  const root = await makeTestTempDir("extend-git-");
  git(root, ["init", "--template="]);
  git(root, ["config", "user.email", "harness-test@example.com"]);
  git(root, ["config", "user.name", "Harness Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  // Ensure we're on a named branch (git init default varies by version).
  const branch = git(root, ["branch", "--show-current"]) || "master";
  if (!branch) {
    git(root, ["checkout", "-b", "master"]);
  }
  return root;
}

test("buildRunBranchName uses harness/run-<slug>-<id>", () => {
  const name = gitMod.buildRunBranchName("My Demo App!", "abc123");
  assert.equal(name, "harness/run-my-demo-app-abc123");
  assert.equal(gitMod.isHarnessBranch(name), true);
  assert.equal(gitMod.isHarnessBranch("harness/extend-legacy-abc123"), false);
  assert.equal(gitMod.isHarnessBranch("main"), false);
});

test("filterRelevantDirtyEntries ignores runtime vendor/cache paths", () => {
  const filtered = gitMod.filterRelevantDirtyEntries([
    { code: "??", path: ".harness-skills/foo/SKILL.md" },
    { code: "??", path: ".harness/runs/x/session.json" },
    { code: " M", path: "packages/nextjs/app/page.tsx" },
    { code: "??", path: "node_modules/lodash/index.js" },
    { code: " M", path: ".cursor/mcp.json" },
  ]);
  assert.deepEqual(
    filtered.map(entry => entry.path),
    ["packages/nextjs/app/page.tsx"],
  );
});

test("createAndCheckoutHarnessBranch creates harness branch from clean HEAD", async () => {
  const root = await initRepo();
  const base = git(root, ["branch", "--show-current"]);
  const created = await gitMod.createAndCheckoutHarnessBranch(root, "demo-spec", "f00bar");
  assert.equal(created.branch, "harness/run-demo-spec-f00bar");
  assert.equal(git(root, ["branch", "--show-current"]), created.branch);
  assert.equal(await gitMod.resolveCurrentBranch(root), created.branch);
  assert.notEqual(base, created.branch);
});

test("assertWorkingTreeCleanForRunStart refuses dirty trees", async () => {
  const root = await initRepo();
  await writeFile(path.join(root, "dirty.txt"), "nope\n");
  await assert.rejects(
    () => gitMod.assertWorkingTreeCleanForRunStart(root),
    /clean working tree/i,
  );
});

test("assertWorkingTreeCleanForRunStart allows only runtime untracked paths", async () => {
  const root = await initRepo();
  await mkdir(path.join(root, ".harness-skills", "x"), { recursive: true });
  await writeFile(path.join(root, ".harness-skills", "x", "SKILL.md"), "# skill\n");
  await gitMod.assertWorkingTreeCleanForRunStart(root);
});

test("commitAttempt stages only consumer-relevant paths", async () => {
  const root = await initRepo();
  await gitMod.createAndCheckoutHarnessBranch(root, "commit-demo", "c0ffee");
  await mkdir(path.join(root, ".harness-skills"), { recursive: true });
  await writeFile(path.join(root, ".harness-skills", "SKILL.md"), "# ignored\n");
  await writeFile(path.join(root, "app.ts"), "export {}\n");

  const result = await gitMod.commitAttempt(root, 1, false, [
    { id: "f1", category: "agent", message: "one" },
    { id: "f2", category: "agent", message: "two" },
  ]);
  assert.equal(result.committed, true);
  assert.match(result.message, /run attempt 1 failed/);
  const show = git(root, ["show", "--name-only", "--pretty=format:", "HEAD"]);
  assert.match(show, /app\.ts/);
  assert.doesNotMatch(show, /harness-skills/);
  const body = git(root, ["log", "-1", "--format=%B"]);
  assert.match(body, /Finding IDs: f1, f2/);
});
