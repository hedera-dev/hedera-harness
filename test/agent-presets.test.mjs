import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { AGENT_PRESETS } = await import(pathToFileURL(path.resolve("dist/specDefaults.js")).href);
const { playwrightMcpConfigArgs, writePlaywrightMcpConfig, withPlaywrightMcpSnapshot } = await import(
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
      ["config-flag", "workspace-file", "config-args"].includes(preset.mcp.kind),
      `${name} has an unknown mcp delivery kind`,
    );
    if (preset.mcp.kind === "config-flag") {
      assert.ok(preset.mcp.flag.startsWith("--"), `${name} flag should be a CLI flag`);
    } else if (preset.mcp.kind === "workspace-file") {
      assert.ok(preset.mcp.path.length > 0, `${name} must name a workspace config path`);
    }
    assert.ok(preset.modelFlag && preset.defaultModel && preset.repairModel, `${name} models`);
  }
});

test("cursor reads a workspace file; claude takes a config path; codex takes args", () => {
  // Cursor's CLI has no flag to point at an MCP config, so the harness must
  // write into the project. Claude does, so the project stays untouched.
  assert.deepEqual(AGENT_PRESETS.cursor.mcp, {
    kind: "workspace-file",
    path: ".cursor/mcp.json",
  });
  assert.deepEqual(AGENT_PRESETS.claude.mcp, { kind: "config-flag", flag: "--mcp-config" });
  assert.deepEqual(AGENT_PRESETS.codex.mcp, { kind: "config-args" });
});

test("codex is invoked non-interactively and never inherits the user's own config", () => {
  const { args } = AGENT_PRESETS.codex;

  assert.equal(args[0], "exec", "codex needs the non-interactive subcommand");
  assert.ok(args.includes("--json"), "the harness parses the JSONL event stream");
  // A user's ~/.codex/config.toml otherwise picks the model and loads their
  // personal MCP servers into the run.
  assert.ok(args.includes("--ignore-user-config"));
  // Without this, every MCP call in `codex exec` comes back "user cancelled".
  assert.ok(args.includes("--approve-for-me"));
  // The built-in ChatGPT apps feature would start a second MCP server.
  assert.equal(args[args.indexOf("--disable") + 1], "apps");
  // workspace-write blocks the network unless it is re-enabled.
  assert.ok(args.includes("sandbox_workspace_write.network_access=true"));
  // The CLI rejects `--sandbox` together with `--approve-for-me`.
  assert.ok(!args.includes("--sandbox") && !args.includes("-s"));
  assert.ok(args.includes("{workspace}") && args.includes("{prompt}"));
});

test("codex MCP overrides carry the playwright server inline as TOML values", async () => {
  const root = await makeTestTempDir("mcp-config-args-");
  const args = await playwrightMcpConfigArgs(root);

  assert.equal(args.filter(arg => arg === "-c").length, 4, "one override per key");
  // A required server fails the session up front instead of a paid turn that
  // reports "browser tools are unavailable"; startup gets the probe's budget.
  assert.ok(args.includes("mcp_servers.playwright.required=true"));
  assert.ok(args.includes("mcp_servers.playwright.startup_timeout_sec=60"));
  const command = args.find(arg => arg.startsWith("mcp_servers.playwright.command="));
  const serverArgs = args.find(arg => arg.startsWith("mcp_servers.playwright.args="));
  assert.ok(command && serverArgs, "both keys must be present");
  // JSON encoding of a string and of a string array are both valid TOML.
  assert.equal(JSON.parse(command.split("=").slice(1).join("=")), "npx");
  assert.ok(Array.isArray(JSON.parse(serverArgs.slice(serverArgs.indexOf("=") + 1))));
});

test("agent preset drives the generator invocation and carries onto the spec", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: claude-run
agent: claude
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.equal(spec.agent, "claude");
  assert.equal(spec.generator.command, "claude");
  assert.ok(spec.generator.args.includes("--model"));
});

test("agent still governs MCP and models when generator is overridden", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
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
  const specPath = await writeRecipe(`schemaVersion: 3
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

test("no preset carries its own model flag, because the loader appends one", () => {
  // Codex refuses a repeated --model; a real run failed both attempts with
  // "the argument '--model <MODEL>' cannot be used multiple times" before the
  // agent did any work.
  for (const [name, preset] of Object.entries(AGENT_PRESETS)) {
    assert.ok(!preset.args.includes(preset.modelFlag), `${name} args must not include ${preset.modelFlag}`);
    assert.ok(
      !(preset.validatorArgs ?? []).includes(preset.modelFlag),
      `${name} validatorArgs must not include ${preset.modelFlag}`,
    );
  }
});

test("a loaded codex recipe passes the model exactly once, and escalation still swaps it", async () => {
  const { withModel } = await import(pathToFileURL(path.resolve("dist/modelSelection.js")).href);
  const specPath = await writeRecipe(`schemaVersion: 3
name: codex-run
agent: codex
validator:
  enabled: true
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);
  const count = args => args.filter(arg => arg === "-m").length;

  assert.equal(count(spec.generator.args), 1, `generator: ${spec.generator.args.join(" ")}`);
  assert.equal(count(spec.validator.args), 1, `validator: ${spec.validator.args.join(" ")}`);
  assert.equal(spec.generator.args[spec.generator.args.indexOf("-m") + 1], AGENT_PRESETS.codex.defaultModel);

  const swapped = withModel(spec.generator, "-m", "some-other-model");
  assert.equal(count(swapped.args), 1);
  assert.equal(swapped.args[swapped.args.indexOf("-m") + 1], "some-other-model");
});
