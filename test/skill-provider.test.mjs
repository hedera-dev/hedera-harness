import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const skillProvider = await import(pathToFileURL(path.resolve("dist/skillProvider.js")).href);

test("resolveSkillsIndex prefers project-local index over bundled", async () => {
  const projectRoot = await makeOsTempDir("harness-skills-local-");
  const localIndex = path.join(projectRoot, "skills-index.json");
  await writeFile(
    localIndex,
    JSON.stringify({
      skills: [{ name: "only-local", path: "./SKILL.md" }],
    }),
  );

  const resolved = await skillProvider.resolveSkillsIndex(projectRoot);
  assert.equal(resolved.sourcePath, localIndex);
  assert.equal(resolved.localPath, localIndex);
  assert.deepEqual(resolved.names, ["only-local"]);
});

test("resolveSkillsIndex falls back to package-bundled index", async () => {
  const projectRoot = await makeOsTempDir("harness-skills-bundled-");
  const resolved = await skillProvider.resolveSkillsIndex(projectRoot);

  assert.equal(resolved.sourcePath, path.resolve("skills-index.json"));
  // Init copies the bundled index to this path.
  assert.equal(resolved.localPath, path.join(projectRoot, "skills-index.json"));
  assert.ok(resolved.names.includes("hedera-token-service"));

  const parsed = JSON.parse(await readFile(resolved.sourcePath, "utf8"));
  assert.ok(Array.isArray(parsed.skills));
});

test("resolveSkillsIndex errors when neither local nor bundled exists", async () => {
  const fakePkg = await makeOsTempDir("harness-skills-missing-");
  // Whole dist so the module's imports resolve; the package root omits skills-index.json.
  await cp(path.resolve("dist"), path.join(fakePkg, "dist"), { recursive: true });

  const isolated = await import(
    `${pathToFileURL(path.join(fakePkg, "dist", "skillProvider.js")).href}?t=${Date.now()}`
  );
  const emptyProject = await makeOsTempDir("harness-skills-empty-proj-");

  await assert.rejects(
    () => isolated.resolveSkillsIndex(emptyProject),
    /Neither file was found|package-bundled/,
  );
});

test("provideSkills rejects an unknown skill name and lists what is registered", async () => {
  const projectRoot = await makeOsTempDir("harness-skills-unknown-");
  await writeFile(
    path.join(projectRoot, "skills-index.json"),
    JSON.stringify({ skills: [{ name: "only-local", path: "./skills/SKILL.md" }] }),
  );

  await assert.rejects(
    () =>
      skillProvider.provideSkills({
        skillRefs: ["nope"],
        projectRoot,
        workspacePath: projectRoot,
        skillsDir: ".harness/runtime/skills",
      }),
    /Unknown skill name "nope".*Available skills.*only-local/s,
  );
});

test("provideSkills vendors an index-registered local skill", async () => {
  const projectRoot = await makeOsTempDir("harness-skills-vendor-");
  const sourceDir = path.join(projectRoot, "skills", "demo");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "SKILL.md"),
    "---\nname: Demo Skill\ndescription: Demo desc\n---\n# Demo\n",
  );
  await writeFile(
    path.join(projectRoot, "skills-index.json"),
    JSON.stringify({ skills: [{ name: "demo", path: "./skills/demo/SKILL.md" }] }),
  );

  const workspacePath = await makeOsTempDir("harness-skills-workspace-");
  const vendored = await skillProvider.provideSkills({
    skillRefs: ["demo"],
    projectRoot,
    workspacePath,
    skillsDir: ".harness/runtime/skills",
  });

  assert.equal(vendored.length, 1);
  assert.equal(vendored[0].name, "Demo Skill");
  assert.equal(vendored[0].description, "Demo desc");
  assert.equal(vendored[0].relativePath, ".harness/runtime/skills/demo-skill/SKILL.md");

  const manifest = JSON.parse(
    await readFile(path.join(workspacePath, ".harness/runtime/skills/manifest.json"), "utf8"),
  );
  assert.equal(manifest.skills.length, 1);
});

test("provideSkills still writes a manifest when no skills are requested", async () => {
  const workspacePath = await makeOsTempDir("harness-skills-empty-");
  const vendored = await skillProvider.provideSkills({
    skillRefs: [],
    projectRoot: workspacePath,
    workspacePath,
    skillsDir: ".harness/runtime/skills",
  });

  assert.deepEqual(vendored, []);
  const manifest = JSON.parse(
    await readFile(path.join(workspacePath, ".harness/runtime/skills/manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.skills, []);
});
