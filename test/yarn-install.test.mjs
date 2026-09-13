import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const yarn = await import(pathToFileURL(path.resolve("dist/yarnInstall.js")).href);

test("nodeModulesLooksInstalled is false for a missing or empty node_modules", async () => {
  const root = await makeTestTempDir("yarn-empty-");
  assert.equal(yarn.nodeModulesLooksInstalled(root), false);
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  assert.equal(yarn.nodeModulesLooksInstalled(root), false);
});

test("nodeModulesLooksInstalled is true when next is present", async () => {
  const root = await makeTestTempDir("yarn-next-");
  await mkdir(path.join(root, "node_modules", "next"), { recursive: true });
  assert.equal(yarn.nodeModulesLooksInstalled(root), true);
});

test("ensureYarnInstall skips when next is already installed", async () => {
  const root = await makeTestTempDir("yarn-skip-");
  await writeFile(path.join(root, "package.json"), '{"name":"app"}\n');
  await mkdir(path.join(root, "node_modules", "next"), { recursive: true });
  const report = await yarn.ensureYarnInstall(root);
  assert.equal(report.kind, "skip");
  assert.match(yarn.formatYarnInstallReport(report), /yarn=skip/);
});

test("ensureYarnInstall is no-package without package.json", async () => {
  const root = await makeTestTempDir("yarn-nopkg-");
  const report = await yarn.ensureYarnInstall(root);
  assert.equal(report.kind, "no-package");
});

test("formatYarnInstallReport is a short block", () => {
  const printed = yarn.formatYarnInstallReport({
    kind: "ok",
    workspace: "D:\\app",
    logFile: "D:\\app\\.harness\\yarn-install.log",
    elapsedMs: 12,
    note: "yarn install finished.",
  });
  assert.ok(printed.split("\n").length <= 8);
  assert.match(printed, /yarn=ok/);
  assert.doesNotMatch(printed, /warning Package /);
});

test("ensureYarnInstall reports missing without spawning yarn", async () => {
  const root = await makeTestTempDir("yarn-missing-");
  await writeFile(path.join(root, "package.json"), '{"name":"app"}\n');
  const report = await yarn.ensureYarnInstall(root);
  assert.equal(report.kind, "missing");
  assert.match(report.note, /tui install/);
});

test("foreground yarn install does not pass --non-interactive", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(path.resolve("src/yarnInstall.ts"), "utf8");
  assert.doesNotMatch(src, /--non-interactive/);
});
