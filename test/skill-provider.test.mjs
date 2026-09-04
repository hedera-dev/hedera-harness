import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";
import { writeProductSkillsRepo } from "./skillFixture.mjs";

const skillProvider = await import(pathToFileURL(path.resolve("dist/skillProvider.js")).href);

test("provideSkills vendors product plugins and skips authoring plugins", async () => {
  const skillsRepo = await writeProductSkillsRepo(await makeOsTempDir("harness-skills-src-"));
  const projectRoot = await makeOsTempDir("harness-skills-project-");
  const workspacePath = await makeOsTempDir("harness-skills-workspace-");

  const vendored = await skillProvider.provideSkills({
    projectRoot,
    workspacePath,
    skillsDir: ".harness/runtime/skills",
    repo: skillsRepo,
    ref: "master",
  });

  assert.equal(vendored.length, 1);
  assert.equal(vendored[0].name, "demo-skill");
  assert.equal(vendored[0].description, "Demo skill.");
  assert.equal(vendored[0].relativePath, ".harness/runtime/skills/demo-skill/SKILL.md");
  assert.equal(vendored[0].referencesPath, ".harness/runtime/skills/demo-skill/references");
  await access(path.join(workspacePath, ".harness/runtime/skills/demo-skill/SKILL.md"));
  await access(path.join(workspacePath, ".harness/runtime/skills/demo-skill/references/api.md"));
  await assert.rejects(() =>
    access(path.join(workspacePath, ".harness/runtime/skills/create-harness-spec/SKILL.md")),
  );

  const manifest = JSON.parse(
    await readFile(path.join(workspacePath, ".harness/runtime/skills/manifest.json"), "utf8"),
  );
  assert.equal(manifest.skills.length, 1);
  assert.equal(manifest.skills[0].name, "demo-skill");
});

test("provideSkills errors when the checkout has no product skills", async () => {
  const skillsRepo = await writeProductSkillsRepo(await makeOsTempDir("harness-skills-empty-src-"), {
    includeProduct: false,
    includeAuthoring: true,
  });
  const projectRoot = await makeOsTempDir("harness-skills-empty-proj-");

  await assert.rejects(
    () =>
      skillProvider.provideSkills({
        projectRoot,
        workspacePath: projectRoot,
        skillsDir: ".harness/runtime/skills",
        repo: skillsRepo,
        ref: "master",
      }),
    /No product skills found/,
  );
});
