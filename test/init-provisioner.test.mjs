import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { makeTestTempDir } from "./tmpDir.mjs";

const provisioner = await import(pathToFileURL(path.resolve("dist/harnessProvisioner.js")).href);
const initSeeder = await import(pathToFileURL(path.resolve("dist/initSeeder.js")).href);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("project harness skeleton files are packaged", async () => {
  const files = await provisioner.listProjectHarnessSkeletonFiles();
  assert.ok(files.includes("spec.yaml"));
  assert.ok(files.includes("prd.md"));
  assert.ok(files.includes("validators/static.json"));
  assert.ok(files.includes("validators/yarn.json"));
  assert.ok(files.includes("gitignore-snippet.txt"));
});

test("provisionHarnessProject writes .harness recipe and gitignore", async () => {
  const root = await makeTestTempDir("init-provision-");
  git(root, ["init", "--template="]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: {}, packageManager: "yarn@3.2.3" }, null, 2),
  );

  const result = await provisioner.provisionHarnessProject({
    targetDir: root,
  });

  assert.equal(await pathExists(path.join(root, ".harness", "spec.yaml")), true);
  assert.equal(await pathExists(path.join(root, ".harness", "prd.md")), true);
  assert.equal(await pathExists(path.join(root, ".harness", "validators", "static.json")), true);
  assert.equal(await pathExists(path.join(root, "skills-index.json")), false);
  assert.equal(result.gitignoreUpdated, true);
  assert.equal(result.packageJsonUpdated, true);

  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /\.harness\/runs\//);
  assert.match(gitignore, /\.harness\/runtime\//);

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["harness:run"], "hedera-harness run .harness/spec.yaml");
});

test("seedProjectForInit refuses non-empty target", async () => {
  const root = await makeTestTempDir("init-seed-");
  await writeFile(path.join(root, "already.txt"), "nope\n");
  await assert.rejects(
    () =>
      initSeeder.seedProjectForInit({
        targetDir: root,
        skipInstall: true,
      }),
    /not empty/i,
  );
});

test("seedProjectForInit clones into empty dir and creates a fresh git repo", async () => {
  const parent = await makeTestTempDir("init-clone-");
  const target = path.join(parent, "app");
  await mkdir(target, { recursive: true });

  // Local seed repo (not this checkout) — CI runs in detached HEAD, so
  // `git clone --branch HEAD` would fail if we used the harness repo itself.
  const localSeed = await makeTestTempDir("init-seed-repo-");
  git(localSeed, ["init", "-b", "main", "--template="]);
  git(localSeed, ["config", "user.email", "test@example.com"]);
  git(localSeed, ["config", "user.name", "Test"]);
  await writeFile(path.join(localSeed, "README.md"), "# seed\n");
  await writeFile(
    path.join(localSeed, "package.json"),
    JSON.stringify({ name: "seed", private: true }, null, 2),
  );
  git(localSeed, ["add", "-A"]);
  git(localSeed, ["commit", "-m", "seed"]);

  const result = await initSeeder.seedProjectForInit({
    targetDir: target,
    repo: localSeed,
    ref: "main",
    skipInstall: true,
  });

  assert.equal(await pathExists(path.join(target, ".git")), true);
  assert.ok(result.commitSha.length >= 7);
  assert.equal(result.preflight.length, 0);
  assert.equal(git(target, ["branch", "--show-current"]), "main");
  assert.equal(git(target, ["rev-list", "--count", "HEAD"]), "1");
  assert.match(git(target, ["log", "-1", "--pretty=%s"]), /Initial scaffold from scaffold-hbar/);
  // No inherited remote from the seed clone.
  const remotes = spawnSync("git", ["remote"], { cwd: target, encoding: "utf8" });
  assert.equal((remotes.stdout || "").trim(), "");
});
