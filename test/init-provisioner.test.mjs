import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { makeTestTempDir } from "./tmpDir.mjs";

const provisioner = await import(pathToFileURL(path.resolve("dist/harnessProvisioner.js")).href);
const initSeeder = await import(pathToFileURL(path.resolve("dist/initSeeder.js")).href);
const recipeAdapt = await import(pathToFileURL(path.resolve("dist/recipeAdapt.js")).href);
const specLoader = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

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
  const spec = await readFile(path.join(root, ".harness", "spec.yaml"), "utf8");
  assert.match(spec, /command: yarn install/);
  assert.match(spec, /command: yarn next:build/);
});

test("adopting an npm app does not plant a yarn next:build recipe", async () => {
  // Nametoll-shaped: npm lockfile, no Yarn, no Next — the advertised in-place
  // adopt path. The skeleton is Scaffold-HBAR; copying it verbatim forbids npm
  // and baselines `yarn next:build`, so doctor/run fail before any agent work.
  const root = await makeTestTempDir("init-npm-adopt-");
  git(root, ["init", "--template="]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "nametoll",
        private: true,
        scripts: {
          start: "tsx src/server.ts",
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');

  const { runInit } = await import(pathToFileURL(path.resolve("dist/initRunner.js")).href);
  const adopted = await runInit({ targetDir: root });

  const spec = await readFile(path.join(root, ".harness", "spec.yaml"), "utf8");
  assert.match(spec, /command: npm install/);
  assert.match(spec, /command: npm run typecheck/);
  assert.doesNotMatch(spec, /yarn next:build/);
  assert.doesNotMatch(spec, /yarn install/);

  const commands = JSON.parse(
    await readFile(path.join(root, ".harness", "validators", "yarn.json"), "utf8"),
  );
  assert.ok(
    commands.forbiddenCommands.includes("yarn install"),
    "an npm project must not be told to avoid npm",
  );
  assert.ok(!commands.forbiddenCommands.includes("npm install"));
  assert.ok(!commands.forbiddenCommands.includes("npm run"));
  assert.equal(
    commands.commands.find(row => row.name === "install")?.command,
    "npm install",
  );
  assert.equal(
    commands.commands.find(row => row.name === "build")?.command,
    "npm run typecheck",
  );
  assert.ok(!commands.commands.some(row => String(row.command).includes("yarn")));

  assert.ok(
    adopted.nextSteps.some(step => /npm run harness:run|hedera-harness run/.test(step)),
    `next steps should not assume Yarn; got ${adopted.nextSteps.join(" | ")}`,
  );
  assert.ok(
    !adopted.nextSteps.includes("yarn harness:run"),
    "next steps must not tell an npm app to run yarn",
  );

  const staticValidator = JSON.parse(
    await readFile(path.join(root, ".harness", "validators", "static.json"), "utf8"),
  );
  assert.deepEqual(staticValidator.jsonAssertions, []);
  assert.ok(
    !staticValidator.fileAssertions.required.includes("packages/nextjs/package.json"),
    "an Express desk does not ship Scaffold-HBAR packages/nextjs",
  );
  assert.ok(!staticValidator.textAssertions.some(row => row.contains?.includes("yarn install")));

  const loaded = await specLoader.loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  assert.equal(loaded.spec.constraints.packageManager, "npm");
  assert.ok(!loaded.spec.constraints.forbiddenCommands.includes("npm install"));
  assert.ok(!loaded.spec.constraints.forbiddenCommands.includes("npm run"));
  assert.ok(loaded.spec.constraints.forbiddenCommands.includes("yarn install"));
});

test("pickAdaptedRecipeCommands uses only scripts that exist", () => {
  assert.equal(recipeAdapt.pickAdaptedRecipeCommands("pnpm", { build: "tsc" }).build, "pnpm build");
  assert.equal(recipeAdapt.pickAdaptedRecipeCommands("pnpm", { build: "tsc" }).install, "pnpm install");
  assert.equal(recipeAdapt.pickAdaptedRecipeCommands("npm", { test: "vitest" }).build, "npm run test");
  assert.equal(recipeAdapt.pickAdaptedRecipeCommands("npm", {}).build, undefined);
  assert.equal(recipeAdapt.pickAdaptedRecipeCommands("yarn", {}).build, "yarn next:build");
  assert.equal(
    recipeAdapt.pickAdaptedRecipeCommands("npm", { "next:build": "next build" }).build,
    "npm run next:build",
  );
});

test("rewriteSkeletonBaseline drops an unverified build command and records the manager", () => {
  const skeleton = [
    "schemaVersion: 3",
    "name: my-feature",
    "baseline:",
    "  commands:",
    "    - name: install",
    "      command: yarn install",
    "    - name: build",
    "      command: yarn next:build",
    "# constraints:",
    "#   packageManager: yarn@3.2.3",
    "",
  ].join("\n");

  const adapted = recipeAdapt.rewriteSkeletonBaseline(skeleton, {
    tool: "npm",
    install: "npm install",
  });
  assert.match(adapted, /command: npm install/);
  assert.doesNotMatch(adapted, /name: build/);
  assert.doesNotMatch(adapted, /npm run build/);
  assert.match(adapted, /^constraints:\n  packageManager: npm$/m);
});

test("adopt does not rewrite a user-authored recipe file that was already there", async () => {
  const root = await makeTestTempDir("init-keep-prd-");
  git(root, ["init", "--template="]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "desk", scripts: { typecheck: "tsc --noEmit" } }, null, 2),
  );
  await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  await mkdir(path.join(root, ".harness"), { recursive: true });
  const existingPrd = [
    "Describe the feature in this existing Scaffold-HBAR project.",
    "- Do not switch the package manager away from Yarn",
    "2. `yarn lint` and `yarn next:build` still pass (baseline + target validators)",
    "",
  ].join("\n");
  await writeFile(path.join(root, ".harness", "prd.md"), existingPrd);

  const result = await provisioner.provisionHarnessProject({ targetDir: root });
  assert.ok(
    result.skippedFiles.some(file => file.replaceAll("\\", "/").endsWith(".harness/prd.md")),
    `prd.md should be skipped; got ${result.skippedFiles.join(", ")}`,
  );
  assert.equal(await readFile(path.join(root, ".harness", "prd.md"), "utf8"), existingPrd);

  const spec = await readFile(path.join(root, ".harness", "spec.yaml"), "utf8");
  assert.match(spec, /command: npm install/);
  assert.match(spec, /packageManager: npm/);
});

test("a Scaffold-HBAR tree keeps the yarn nextjs static assertions", async () => {
  const root = await makeTestTempDir("init-scaffold-static-");
  git(root, ["init", "--template="]);
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "scaffold", packageManager: "yarn@3.2.3", scripts: {} }, null, 2),
  );
  await mkdir(path.join(root, "packages", "nextjs"), { recursive: true });
  await writeFile(path.join(root, "packages", "nextjs", "package.json"), '{"name":"nextjs"}\n');

  await provisioner.provisionHarnessProject({ targetDir: root });

  const staticValidator = JSON.parse(
    await readFile(path.join(root, ".harness", "validators", "static.json"), "utf8"),
  );
  assert.equal(staticValidator.jsonAssertions[0]?.equals, "yarn@3.2.3");
  assert.ok(staticValidator.fileAssertions.required.includes("packages/nextjs/package.json"));
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
