import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const skillResolver = await import(pathToFileURL(path.resolve("dist/skillResolver.js")).href);

test("bundledSkillsIndexPath resolves next to package root from dist/", () => {
  const bundled = skillResolver.bundledSkillsIndexPath();
  assert.equal(bundled, path.resolve("skills-index.json"));
});

test("resolveSkillsIndexPath prefers project-local index over bundled", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "harness-skills-local-"));
  const localIndex = path.join(projectRoot, "skills-index.json");
  await writeFile(
    localIndex,
    JSON.stringify({
      skills: [{ name: "only-local", path: "./SKILL.md" }],
    }),
  );

  const resolved = await skillResolver.resolveSkillsIndexPath(projectRoot);
  assert.equal(resolved, localIndex);
});

test("resolveSkillsIndexPath falls back to package-bundled index", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "harness-skills-bundled-"));
  const resolved = await skillResolver.resolveSkillsIndexPath(projectRoot);
  assert.equal(resolved, path.resolve("skills-index.json"));

  // Bundled index is readable JSON with the expected skill registry shape.
  const raw = await import("node:fs/promises").then(fs => fs.readFile(resolved, "utf8"));
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.skills));
  assert.ok(parsed.skills.some(skill => skill.name === "hedera-token-service"));
});

test("resolveSkillsIndexPath errors when neither local nor bundled exists", async () => {
  const fakePkg = await mkdtemp(path.join(os.tmpdir(), "harness-skills-missing-"));
  const fakeDist = path.join(fakePkg, "dist");
  await mkdir(fakeDist, { recursive: true });

  // Copy compiled resolver but omit skills-index.json from the fake package root.
  await cp(path.resolve("dist/skillResolver.js"), path.join(fakeDist, "skillResolver.js"));
  // skillResolver imports skillRepoCache — provide a stub so the module loads.
  await writeFile(
    path.join(fakeDist, "skillRepoCache.js"),
    "export async function ensureSkillRepoCheckout() { throw new Error('stub'); }\n",
  );

  const isolated = await import(pathToFileURL(path.join(fakeDist, "skillResolver.js")).href + `?t=${Date.now()}`);
  const emptyProject = await mkdtemp(path.join(os.tmpdir(), "harness-skills-empty-proj-"));

  await assert.rejects(
    () => isolated.resolveSkillsIndexPath(emptyProject),
    /Neither file was found|package-bundled/,
  );
});
