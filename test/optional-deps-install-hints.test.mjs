import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const optionalDeps = await import(pathToFileURL(path.resolve("dist/optionalDeps.js")).href);

test("resolvePackageInstallTool prefers constraints.packageManager hint", async () => {
  const tool = await optionalDeps.resolvePackageInstallTool({
    packageManager: "yarn@3.2.3",
    projectRoot: "/tmp/does-not-matter",
  });
  assert.equal(tool, "yarn");
});

test("resolvePackageInstallTool reads package.json packageManager", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-pm-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "demo", packageManager: "yarn@3.2.3" }),
    );
    const tool = await optionalDeps.resolvePackageInstallTool({ projectRoot: dir });
    assert.equal(tool, "yarn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvePackageInstallTool falls back to yarn.lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-yarnlock-"));
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    await writeFile(path.join(dir, "yarn.lock"), "# yarn\n");
    const tool = await optionalDeps.resolvePackageInstallTool({ projectRoot: dir });
    assert.equal(tool, "yarn");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildOptionalDepInstallLines uses yarn add for yarn projects", () => {
  assert.deepEqual(optionalDeps.buildOptionalDepInstallLines("playwright", "yarn"), [
    "yarn add -D playwright",
  ]);
});

test("buildOptionalDepInstallLines keeps npm for npm projects", () => {
  assert.deepEqual(optionalDeps.buildOptionalDepInstallLines("playwright", "npm"), [
    "npm install -D playwright",
  ]);
});

test("formatOptionalDepError mentions yarn add when project is yarn-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-fmt-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "demo", packageManager: "yarn@3.2.3" }),
    );
    const message = await optionalDeps.formatOptionalDepError(
      "playwright",
      "SMOKE Playwright gate",
      { projectRoot: dir, packageManager: "yarn@3.2.3" },
      new Error("Cannot find package 'playwright'"),
    );
    assert.match(message, /yarn add -D playwright/);
    assert.doesNotMatch(message, /npm install -D playwright/);
    assert.match(message, /project root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
