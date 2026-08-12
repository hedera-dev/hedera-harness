import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const defaults = await import(pathToFileURL(path.resolve("dist/specDefaults.js")).href);

const MINIMAL_BASELINE = `baseline:
  commands:
    - name: install
      command: "true"
`;

/** Write a recipe and the files the loader's preflight expects to exist. */
async function writeRecipe(body, { prefix = "spec-", extraFiles = {} } = {}) {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  for (const [relative, contents] of Object.entries(extraFiles)) {
    await writeFile(path.join(root, relative), contents);
  }
  await writeFile(path.join(root, ".harness", "spec.yaml"), body);
  return { root, specPath: path.join(root, ".harness", "spec.yaml") };
}

test("a minimal v2 recipe loads on defaults alone", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: my-feature
${MINIMAL_BASELINE}`);

  const { spec, warnings } = await loadTemplateSpec(specPath);

  assert.equal(spec.schemaVersion, 2);
  assert.equal(spec.name, "my-feature");
  assert.equal(spec.maxAttempts, defaults.DEFAULT_MAX_ATTEMPTS);
  assert.match(spec.prdPaths[0], /\.harness\/prd\.md$/);
  assert.match(spec.validators.staticPath, /\.harness\/validators\/static\.json$/);
  assert.match(spec.validators.commandsPath, /\.harness\/validators\/yarn\.json$/);
  // Logging is harness-owned regardless of what the recipe says.
  assert.match(spec.logging.jsonlPath, /\.harness\/runs\/harness\.log\.jsonl$/);
  assert.deepEqual(warnings.filter(w => w.includes("unknown key")), []);
});

test("agent preset supplies the generator; explicit generator still wins", async () => {
  const preset = await writeRecipe(`schemaVersion: 2
name: preset
agent: claude
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(preset.specPath);
  assert.equal(spec.generator.command, "claude");
  assert.ok(spec.generator.args.includes("{prompt}"));

  const explicit = await writeRecipe(`schemaVersion: 2
name: explicit
agent: claude
generator:
  provider: command
  command: my-agent
  args: ["--go"]
${MINIMAL_BASELINE}`);
  const result = await loadTemplateSpec(explicit.specPath);
  assert.equal(result.spec.generator.command, "my-agent");
  assert.deepEqual(result.spec.generator.args, ["--go"]);
});

test("default agent preset is used when none is named", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: default-agent
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.generator.command, defaults.AGENT_PRESETS[defaults.DEFAULT_AGENT_PRESET].command);
});

test("an unknown agent preset names the available ones", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: bad-agent
agent: copilot
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(specPath), /Unknown agent preset.*cursor, claude/s);
});

test("forbiddenCommands and secret files derive from the package manager and workspaces", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: derived
constraints:
  packageManager: yarn@3.2.3
  workspaces:
    - packages/nextjs
${MINIMAL_BASELINE}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.ok(spec.constraints.forbiddenCommands.includes("npm install"));
  assert.ok(spec.constraints.forbiddenCommands.includes("pnpm run"));
  assert.ok(!spec.constraints.forbiddenCommands.some(c => c.startsWith("yarn")));
  assert.deepEqual(spec.forbiddenFiles, [".env", "packages/nextjs/.env"]);
  assert.deepEqual(spec.secretScan.failOnFiles, [".env", "packages/nextjs/.env"]);
  assert.ok(spec.secretScan.patterns.length > 0);
});

test("a schemaVersion above the supported max names the fix", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 99
name: too-new
${MINIMAL_BASELINE}`);
  await assert.rejects(
    () => loadTemplateSpec(specPath),
    /understands up to 2.*npm install hedera-harness@latest/s,
  );
});

test("a non-integer schemaVersion is rejected", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: "two"
name: bad-version
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(specPath), /must be a positive integer/);
});

test("unknown top-level keys warn instead of being silently dropped", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: unknown-keys
programme: something-from-a-newer-recipe
${MINIMAL_BASELINE}`);

  const { warnings } = await loadTemplateSpec(specPath);
  assert.ok(warnings.some(w => w.includes("programme")), warnings.join(" | "));
});

test("a legacy v1 recipe still loads, with deprecation warnings", async () => {
  const { specPath } = await writeRecipe(`name: legacy
prd: .harness/prd.md
generator:
  provider: command
  command: agent
extend:
  baseline:
    commands:
      - name: install
        command: "true"
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
requiredFiles: []
forbiddenFiles: []
logging:
  jsonl: .harness/runs/harness.log.jsonl
  notes: .harness/runs/harness-notes.md
`);

  const { spec, warnings } = await loadTemplateSpec(specPath);

  assert.equal(spec.schemaVersion, 1, "absent version means the original schema");
  assert.equal(spec.baseline.commands[0].name, "install", "extend.baseline still maps to baseline");
  assert.ok(warnings.some(w => w.includes("extend.baseline")), warnings.join(" | "));
  assert.ok(warnings.some(w => w.includes("logging")), warnings.join(" | "));
});

test("prd accepts a single-entry list but refuses multiple until slices land", async () => {
  const single = await writeRecipe(`schemaVersion: 2
name: one-prd
prd:
  - .harness/prd.md
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(single.specPath);
  assert.equal(spec.prdPaths.length, 1);

  const many = await writeRecipe(`schemaVersion: 2
name: many-prds
prd:
  - .harness/prd.md
  - .harness/prd-2.md
${MINIMAL_BASELINE}`);
  await assert.rejects(
    () => loadTemplateSpec(many.specPath),
    /sequential slice delivery is not implemented yet/,
  );
});

test("baseline without an install command is still rejected", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 2
name: no-install
baseline:
  commands:
    - name: lint
      command: "true"
`);
  await assert.rejects(() => loadTemplateSpec(specPath), /named "install"/);
});
