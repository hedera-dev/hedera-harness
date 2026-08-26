import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { AGENT_PRESETS } = await import(pathToFileURL(path.resolve("dist/specDefaults.js")).href);
const { writePlaywrightMcpConfig, withPlaywrightMcpSnapshot } = await import(
  pathToFileURL(path.resolve("dist/mcpBrowser.js")).href
);

const MINIMAL_BASELINE = `baseline:
  commands:
    - name: install
      command: "true"
`;

async function writeRecipe(body, prefix = "agent-") {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "spec.yaml"), body);
  return path.join(root, ".harness", "spec.yaml");
}

test("every preset declares how MCP reaches its CLI", () => {
  for (const [name, preset] of Object.entries(AGENT_PRESETS)) {
    assert.ok(preset.mcp, `${name} must declare mcp delivery`);
    assert.ok(
      preset.mcp.kind === "config-flag" || preset.mcp.kind === "workspace-file",
      `${name} has an unknown mcp delivery kind`,
    );
    if (preset.mcp.kind === "config-flag") {
      assert.ok(preset.mcp.flag.startsWith("--"), `${name} flag should be a CLI flag`);
    } else {
      assert.ok(preset.mcp.path.length > 0, `${name} must name a workspace config path`);
    }
    assert.ok(preset.modelFlag && preset.defaultModel && preset.repairModel, `${name} models`);
  }
});

test("cursor reads a workspace file; claude takes a config path", () => {
  // Cursor's CLI has no flag to point at an MCP config, so the harness must
  // write into the project. Claude does, so the project stays untouched.
  assert.deepEqual(AGENT_PRESETS.cursor.mcp, {
    kind: "workspace-file",
    path: ".cursor/mcp.json",
  });
  assert.deepEqual(AGENT_PRESETS.claude.mcp, { kind: "config-flag", flag: "--mcp-config" });
});

test("agent preset drives the generator invocation and carries onto the spec", async () => {
  const specPath = await writeRecipe(`schemaVersion: 2
name: claude-run
agent: claude
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.equal(spec.agent, "claude");
  assert.equal(spec.generator.command, "claude");
  assert.ok(spec.generator.args.includes("--model"));
});

test("agent still governs MCP and models when generator is overridden", async () => {
  const specPath = await writeRecipe(`schemaVersion: 2
name: override
agent: claude
generator:
  provider: command
  command: my-wrapper
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.equal(spec.generator.command, "my-wrapper");
  // The preset still decides how the validator gets browser tools.
  assert.equal(spec.agent, "claude");
});

test("enabling the validator needs no second copy of the agent invocation", async () => {
  const specPath = await writeRecipe(`schemaVersion: 2
name: validator-inherits
agent: claude
validator:
  enabled: true
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.equal(spec.validator.enabled, true);
  assert.equal(spec.validator.command, "claude", "validator should inherit the preset command");
  assert.ok(spec.validator.args.length > 0, "validator should inherit the preset args");
});

test("writePlaywrightMcpConfig produces a standalone config outside the project", async () => {
  const root = await makeTestTempDir("mcp-standalone-");
  const target = path.join(root, "runs", "abc", "mcp", "playwright.json");

  await writePlaywrightMcpConfig(target, root);

  const config = JSON.parse(await readFile(target, "utf8"));
  assert.ok(config.mcpServers.playwright.command, "playwright server must be declared");
  assert.ok(Array.isArray(config.mcpServers.playwright.args));
});

test("withPlaywrightMcpSnapshot removes the file it created when none existed", async () => {
  const root = await makeTestTempDir("mcp-snapshot-");
  let sawPlaywright = false;

  await withPlaywrightMcpSnapshot(root, ".cursor/mcp.json", async () => {
    const during = JSON.parse(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
    sawPlaywright = Boolean(during.mcpServers?.playwright);
  });

  assert.equal(sawPlaywright, true);
  await assert.rejects(() => readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
});
