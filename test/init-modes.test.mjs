import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { detectInitMode, resolveTemplateRef } = await import(
  pathToFileURL(path.resolve("dist/initSeeder.js")).href
);
const { runInit } = await import(pathToFileURL(path.resolve("dist/initRunner.js")).href);

test("resolveTemplateRef prefixes a bare template name", () => {
  // Templates are branches, so a bare name has to become templates/<name>.
  assert.equal(resolveTemplateRef("hedera-demo"), "templates/hedera-demo");
  assert.equal(resolveTemplateRef("  oracles  "), "templates/oracles");
});

test("resolveTemplateRef passes a qualified ref through", () => {
  assert.equal(resolveTemplateRef("templates/bridge"), "templates/bridge");
  assert.equal(resolveTemplateRef("draft-templates/x"), "draft-templates/x");
});

test("a missing target is scaffolded", async () => {
  const root = await makeTestTempDir("init-mode-");
  const mode = await detectInitMode(path.join(root, "does-not-exist"));
  assert.equal(mode.kind, "seed-new");
});

test("an empty directory is scaffolded", async () => {
  const root = await makeTestTempDir("init-empty-");
  assert.equal((await detectInitMode(root)).kind, "seed-empty");
});

test("a directory holding a project is adopted in place", async () => {
  const root = await makeTestTempDir("init-project-");
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  assert.equal((await detectInitMode(root)).kind, "in-place");
});

test("a non-empty directory that is not a project is refused", async () => {
  // Provisioning into an arbitrary folder is not a recoverable mistake.
  const root = await makeTestTempDir("init-junk-");
  await writeFile(path.join(root, "notes.txt"), "hello\n");

  await assert.rejects(() => detectInitMode(root), /does not look like a project/);
});

test("init in a project provisions without cloning", async () => {
  const root = await makeTestTempDir("init-adopt-");
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');

  const result = await runInit({ targetDir: root });

  assert.equal(result.mode, "in-place");
  assert.equal(result.repo, undefined, "nothing was cloned");
  assert.ok(result.writtenFiles.length > 0, "a recipe should be provisioned");
  assert.deepEqual(result.skippedFiles, []);
});

test("init never overwrites a recipe that already exists", async () => {
  const root = await makeTestTempDir("init-keep-");
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "spec.yaml"), "name: mine\n");

  const result = await runInit({ targetDir: root });

  assert.ok(
    result.skippedFiles.includes(path.join(".harness", "spec.yaml")),
    `expected spec.yaml to be kept; got ${result.skippedFiles.join(", ")}`,
  );
  // A template author's recipe must survive adoption untouched.
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(path.join(root, ".harness", "spec.yaml"), "utf8"), "name: mine\n");
  assert.ok(
    result.nextSteps.some(step => step.includes("already had a .harness/ recipe")),
    "next steps should say the recipe was left alone",
  );
});
