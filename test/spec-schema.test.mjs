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

test("a minimal v3 recipe loads on defaults alone", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}`);

  const { spec, warnings } = await loadTemplateSpec(specPath);

  assert.equal(spec.schemaVersion, 3);
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
  const preset = await writeRecipe(`schemaVersion: 3
name: preset
agent: claude
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(preset.specPath);
  assert.equal(spec.generator.command, "claude");
  assert.ok(spec.generator.args.includes("{prompt}"));

  const explicit = await writeRecipe(`schemaVersion: 3
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
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: default-agent
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(defaults.DEFAULT_AGENT_PRESET, "claude");
  assert.equal(spec.agent, "claude");
  assert.equal(spec.generator.command, "claude");
  assert.equal(spec.generator.command, defaults.AGENT_PRESETS[defaults.DEFAULT_AGENT_PRESET].command);
});

test("explicit agent: cursor still selects the Cursor preset", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: cursor-override
agent: cursor
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.agent, "cursor");
  assert.equal(spec.generator.command, "agent");
});

test("an unknown agent preset names the available ones", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: bad-agent
agent: copilot
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(specPath), /Unknown agent preset.*cursor, claude/s);
});

test("forbiddenCommands and secret files derive from the package manager and workspaces", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
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
    /understands up to 3.*npm install hedera-harness@latest/s,
  );
});

test("a non-integer schemaVersion is rejected", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: "two"
name: bad-version
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(specPath), /must be a positive integer/);
});

test("unknown top-level keys warn instead of being silently dropped", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: unknown-keys
programme: something-from-a-newer-recipe
${MINIMAL_BASELINE}`);

  const { warnings } = await loadTemplateSpec(specPath);
  assert.ok(warnings.some(w => w.includes("programme")), warnings.join(" | "));
});

test("removed contract key fails at load naming eval", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: still-has-contract
contract: .harness/acceptance-contract.json
validator:
  enabled: true
validators:
  playwright: .harness/validators/playwright-smoke.yaml
${MINIMAL_BASELINE}`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    error => {
      assert.match(String(error), /removed key\(s\): contract/);
      assert.match(String(error), /use eval: not contract:/);
      assert.doesNotMatch(String(error), /migrate/);
      assert.doesNotMatch(String(error), /upgrade the harness/);
      return true;
    },
  );
});

test("removed extend key fails at load naming baseline", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: still-has-extend
extend:
  baseline:
    commands:
      - name: install
        command: "true"
`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    error => {
      assert.match(String(error), /removed key\(s\): extend/);
      assert.match(String(error), /use baseline: not extend:/);
      assert.doesNotMatch(String(error), /migrate/);
      return true;
    },
  );
});

// v1 required `logging`, so it outlives contract/extend in hand-written recipes.
// As an unknown key it drew "upgrade the harness" — the opposite of the fix.
test("removed logging key fails at load instead of warning", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: still-has-logging
logging:
  jsonlPath: .harness/custom.jsonl
${MINIMAL_BASELINE}`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    error => {
      assert.match(String(error), /removed key\(s\): logging/);
      assert.match(String(error), /\.harness\/runs\//);
      assert.doesNotMatch(String(error), /upgrade the harness/);
      assert.doesNotMatch(String(error), /migrate/);
      return true;
    },
  );
});

test("missing or older schemaVersion is rejected", async () => {
  const missing = await writeRecipe(`name: no-version
${MINIMAL_BASELINE}`);
  await assert.rejects(
    () => loadTemplateSpec(missing.specPath),
    /missing schemaVersion.*Set schemaVersion: 3/s,
  );

  const old = await writeRecipe(`schemaVersion: 2
name: too-old
${MINIMAL_BASELINE}`);
  await assert.rejects(
    () => loadTemplateSpec(old.specPath),
    /schemaVersion 2.*Set schemaVersion: 3/s,
  );
});

test("prd accepts a scalar, a single-entry list, or an ordered list of increments", async () => {
  const single = await writeRecipe(`schemaVersion: 3
name: one-prd
prd:
  - .harness/prd.md
${MINIMAL_BASELINE}`);
  assert.equal((await loadTemplateSpec(single.specPath)).spec.prdPaths.length, 1);

  const many = await writeRecipe(`schemaVersion: 3
name: many-prds
prd:
  - .harness/01-foundation.md
  - .harness/02-ui.md
  - .harness/03-onchain.md
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(many.specPath);

  assert.equal(spec.prdPaths.length, 3, "increments are delivered in listed order");
  assert.match(spec.prdPaths[0], /01-foundation\.md$/);
  assert.match(spec.prdPaths[2], /03-onchain\.md$/);
});

test("prd rejects an empty list and non-string entries", async () => {
  const empty = await writeRecipe(`schemaVersion: 3
name: empty-prd
prd: []
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(empty.specPath), /at least one PRD/);

  const bad = await writeRecipe(`schemaVersion: 3
name: bad-prd
prd:
  - 42
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(bad.specPath), /path or a non-empty list/);
});

test("eval accepts a scalar path or a list matching prd length", async () => {
  const scalar = await writeRecipe(`schemaVersion: 3
name: scalar-eval
eval: .harness/eval.json
${MINIMAL_BASELINE}`);
  const loadedScalar = await loadTemplateSpec(scalar.specPath);
  assert.equal(loadedScalar.spec.evalPaths?.length, 1);
  assert.match(loadedScalar.spec.evalPaths[0], /\.harness\/eval\.json$/);

  const list = await writeRecipe(
    `schemaVersion: 3
name: list-eval
prd:
  - .harness/01.md
  - .harness/02.md
eval:
  - .harness/eval-01.json
  - .harness/eval-02.json
${MINIMAL_BASELINE}`,
    {
      extraFiles: {
        ".harness/01.md": "# 1\n",
        ".harness/02.md": "# 2\n",
        ".harness/eval-01.json": "{}\n",
        ".harness/eval-02.json": "{}\n",
      },
    },
  );
  const loadedList = await loadTemplateSpec(list.specPath);
  assert.equal(loadedList.spec.evalPaths?.length, 2);
  assert.match(loadedList.spec.evalPaths[0], /eval-01\.json$/);
  assert.match(loadedList.spec.evalPaths[1], /eval-02\.json$/);
});

test("eval list must be 1:1 with prd length; empty list is rejected", async () => {
  const mismatch = await writeRecipe(`schemaVersion: 3
name: mismatch-eval
prd:
  - .harness/a.md
  - .harness/b.md
eval:
  - .harness/only.json
${MINIMAL_BASELINE}`);
  await assert.rejects(
    () => loadTemplateSpec(mismatch.specPath),
    /eval.*1 path.*prd.*2|list form must be 1:1/s,
  );

  const empty = await writeRecipe(`schemaVersion: 3
name: empty-eval
eval: []
${MINIMAL_BASELINE}`);
  await assert.rejects(() => loadTemplateSpec(empty.specPath), /at least one path/);
});

test("absent eval leaves evalPaths undefined", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: no-eval
${MINIMAL_BASELINE}`);
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.evalPaths, undefined);
});

test("baseline without an install command is still rejected", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: no-install
baseline:
  commands:
    - name: lint
      command: "true"
`);
  await assert.rejects(() => loadTemplateSpec(specPath), /named "install"/);
});

test("the install error names baseline.commands", async () => {
  const missing = await writeRecipe(`schemaVersion: 3
name: no-install
baseline:
  commands:
    - name: lint
      command: "true"
`);
  await assert.rejects(() => loadTemplateSpec(missing.specPath), error => {
    assert.match(error.message, /baseline\.commands/);
    assert.doesNotMatch(error.message, /extend\.baseline/);
    return true;
  });

  const empty = await writeRecipe(`schemaVersion: 3
name: empty-baseline
baseline:
  commands: []
`);
  await assert.rejects(() => loadTemplateSpec(empty.specPath), error => {
    assert.doesNotMatch(error.message, /extend\.baseline/);
    return true;
  });
});
