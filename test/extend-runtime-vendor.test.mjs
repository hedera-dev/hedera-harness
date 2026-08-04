import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { vendorSkills } = await import(pathToFileURL(path.resolve("dist/skillVendor.js")).href);
const { vendorHarnessContext, withPlaywrightMcpSnapshot } = await import(
  pathToFileURL(path.resolve("dist/contextVendor.js")).href
);
const { EXTEND_CONTEXT_DIR, EXTEND_SKILLS_DIR } = await import(
  pathToFileURL(path.resolve("dist/runtimePaths.js")).href
);

test("extend vendoring writes skills/context under .harness/runtime and skips MCP mutation", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-test", "extend-runtime-"));
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { existing: { command: "echo" } } }, null, 2),
  );
  const beforeMcp = await readFile(path.join(root, ".cursor", "mcp.json"), "utf8");

  const skillDir = path.join(root, "skill-src");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo-skill\ndescription: Demo\n---\n# Demo\n",
  );
  const prdPath = path.join(root, "prd.md");
  await writeFile(prdPath, "# PRD\n");

  const skills = await vendorSkills(root, [path.join(skillDir, "SKILL.md")], {
    skillsDir: EXTEND_SKILLS_DIR,
  });
  assert.equal(skills.length, 1);
  assert.ok(skills[0].relativePath.startsWith(`${EXTEND_SKILLS_DIR}/`));
  await access(path.join(root, ...skills[0].relativePath.split("/")));

  const context = await vendorHarnessContext(
    root,
    { prdPath },
    { contextDir: EXTEND_CONTEXT_DIR, injectPlaywrightMcp: false },
  );
  assert.equal(context.prdRelativePath, `${EXTEND_CONTEXT_DIR}/prd.md`);
  assert.equal(context.playwrightMcpPath, undefined);
  await access(path.join(root, ...context.prdRelativePath.split("/")));

  // Root vendor dirs for isolated mode must not appear.
  await assert.rejects(() => access(path.join(root, ".harness-skills")));
  await assert.rejects(() => access(path.join(root, ".harness-context")));

  assert.equal(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"), beforeMcp);
});

test("withPlaywrightMcpSnapshot restores prior mcp.json", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".tmp-test", "extend-mcp-"));
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  const original = `${JSON.stringify({ mcpServers: { keep: { command: "true" } } }, null, 2)}\n`;
  await writeFile(path.join(root, ".cursor", "mcp.json"), original);

  let sawPlaywright = false;
  await withPlaywrightMcpSnapshot(root, async () => {
    const during = JSON.parse(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    sawPlaywright = Boolean(during.mcpServers?.playwright);
  });

  assert.equal(sawPlaywright, true);
  assert.equal(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"), original);
});
