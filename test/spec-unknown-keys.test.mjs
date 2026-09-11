import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { collectUnknownSpecKeys, formatUnknownSpecKeys, suggestKey, SPEC_SHAPE } = await import(
  pathToFileURL(path.resolve("dist/specKeys.js")).href
);
const { KNOWN_SPEC_KEYS } = await import(pathToFileURL(path.resolve("dist/specDefaults.js")).href);

const MINIMAL_BASELINE = `baseline:
  commands:
    - name: install
      command: "true"
`;

/** Write a recipe plus the files a loaded recipe points at. */
async function writeRecipe(body, prefix = "unknown-keys-") {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "spec.yaml"), body);
  return path.join(root, ".harness", "spec.yaml");
}

/** loadTemplateSpec logs its warnings; tests assert on the returned copy. */
async function loadQuietly(specPath) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await loadTemplateSpec(specPath);
  } finally {
    console.warn = original;
  }
}

const paths = unknown => unknown.map(entry => entry.path);

test("a misspelled key inside a block is reported with its dotted path", () => {
  const unknown = collectUnknownSpecKeys({
    schemaVersion: 3,
    chainValidation: { expose: { envVar: ["NEXT_PUBLIC_X"] } },
  });

  assert.deepEqual(unknown, [{ path: "chainValidation.expose.envVar", suggestion: "envVars" }]);
});

test("a misspelled key inside a list item carries its index", () => {
  const unknown = collectUnknownSpecKeys({
    baseline: { commands: [{ name: "install", command: "yarn install", timeoutMS: 900000 }] },
  });

  assert.deepEqual(unknown, [
    { path: "baseline.commands[0].timeoutMS", suggestion: "timeoutMs" },
  ]);
});

test("case-only misspellings name the exact key", () => {
  assert.equal(suggestKey("fundingHBAR", ["fundingHbar", "sweepBack"]), "fundingHbar");
  assert.equal(suggestKey("packagemanager", ["packageManager"]), "packageManager");
  assert.equal(suggestKey("TimeoutMs", ["timeoutMs"]), "timeoutMs");
});

test("suggestKey stays quiet when nothing is close", () => {
  assert.equal(suggestKey("telemetryEndpoint", [...KNOWN_SPEC_KEYS]), undefined);
  assert.equal(suggestKey("zz", ["eval", "prd", "name"]), undefined);
});

test("an unknown key with no near match keeps the upgrade hint", () => {
  const [line] = formatUnknownSpecKeys(
    collectUnknownSpecKeys({ schemaVersion: 3, telemetryEndpoint: "https://example.test" }),
  );

  assert.match(line, /unknown key "telemetryEndpoint"/);
  assert.match(line, /upgrade the harness/);
  assert.doesNotMatch(line, /did you mean/);
});

test("every block a working recipe uses is registered — no warnings on a full recipe", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: full
description: every block populated
prd: .harness/prd.md
agent: claude
maxAttempts: 2
generator:
  provider: command
  command: node
  args: ["--version"]
  env:
    ANY_CALLER_DEFINED_NAME: "1"
  timeoutMs: 1000
validator:
  enabled: false
constraints:
  packageManager: yarn
  workspaces: [packages/nextjs]
  forbiddenWorkspaces: []
  forbiddenCommands: []
templateMetadata:
  name: demo
  anythingATemplateBranchAdds: fine
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
requiredFiles: []
forbiddenFiles: [.env]
secretScan:
  failOnFiles: [.env]
  patterns:
    - name: private-key-assignment
      pattern: "PRIVATE_KEY"
      allowIn: []
chainValidation:
  enabled: false
  network: testnet
  fundingHbar: 20
  sweepBack: true
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  expose:
    browserLocalStorageKey: burnerWallet.pk
    envVars: [NEXT_PUBLIC_X]
  deploy:
    commands:
      - name: deploy
        command: "true"
        timeoutMs: 1000
${MINIMAL_BASELINE}`);

  const loaded = await loadQuietly(specPath);
  assert.deepEqual(loaded.warnings, []);
});

test("removed keys fail the load instead of being reported as unknown", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: removed
contract: .harness/acceptance-contract.json
${MINIMAL_BASELINE}`);

  await assert.rejects(() => loadQuietly(specPath), /use eval: not contract:/);
  assert.deepEqual(paths(collectUnknownSpecKeys({ contract: "x", extend: {} })), []);
});

test("the recipe still loads with defaults — the warning is the only signal", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: silent-fallback
chainValidation:
  enable: false
  network: testnet
  fundingHBAR: 50
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  expose:
    envVar: [NEXT_PUBLIC_X]
${MINIMAL_BASELINE}`);

  const loaded = await loadQuietly(specPath);

  // What the author asked for, and what the loader actually used.
  assert.equal(loaded.spec.chainValidation?.enabled, true);
  assert.equal(loaded.spec.chainValidation?.fundingHbar, 10);
  assert.deepEqual(loaded.spec.chainValidation?.expose.envVars, []);

  assert.deepEqual(paths(collectUnknownSpecKeys(await readYaml(specPath))), [
    "chainValidation.enable",
    "chainValidation.fundingHBAR",
    "chainValidation.expose.envVar",
  ]);
  assert.equal(loaded.warnings.length, 3);
  assert.match(loaded.warnings[0], /did you mean "enabled"\?/);
});

test("caller-defined records are not walked", () => {
  const unknown = collectUnknownSpecKeys({
    generator: { command: "agent", env: { WHATEVER_THE_AGENT_NEEDS: "1" } },
    templateMetadata: { name: "demo", extraFieldFromATemplateBranch: true },
  });

  assert.deepEqual(unknown, []);
});

test("the shape covers every top-level key the loader accepts", () => {
  assert.deepEqual(
    [...KNOWN_SPEC_KEYS].sort(),
    Object.keys(SPEC_SHAPE).sort(),
    "register new top-level keys in SPEC_SHAPE (src/specKeys.ts) as well as KNOWN_SPEC_KEYS",
  );
});

async function readYaml(specPath) {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  return parse(await readFile(specPath, "utf8"));
}
