import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

const MINIMAL_BASELINE = `baseline:
  commands:
    - name: install
      command: "true"
`;

async function writeRecipe(body, extra = {}) {
  const root = await makeTestTempDir("scenario-schema-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  for (const [relative, contents] of Object.entries(extra)) {
    await writeFile(path.join(root, relative), contents);
  }
  await writeFile(path.join(root, ".harness", "spec.yaml"), body);
  return path.join(root, ".harness", "spec.yaml");
}

test("scenarios load inline and reuse chainValidation.operator", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: scenes
${MINIMAL_BASELINE}
chainValidation:
  enabled: true
  network: testnet
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
scenarios:
  enabled: true
  actors:
    alice:
      fundHbar: 5
    bob:
      fundHbar: 2
  steps:
    - id: pay
      actor: alice
      transferHbar:
        to: bob
        hbar: 1
  assert:
    - accountHbar:
        actor: bob
        min: 0.5
`);
  const { spec, warnings } = await loadTemplateSpec(specPath);
  assert.equal(spec.scenarios?.enabled, true);
  assert.equal(Object.keys(spec.scenarios.plan.actors).length, 2);
  assert.equal(spec.scenarios.plan.steps[0].id, "pay");
  assert.deepEqual(warnings.filter(w => w.includes("unknown key")), []);
});

test("scenarios file: is loaded from the project", async () => {
  const specPath = await writeRecipe(
    `schemaVersion: 3
name: from-file
${MINIMAL_BASELINE}
scenarios:
  enabled: true
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  file: .harness/scenarios.yaml
`,
    {
      ".harness/scenarios.yaml": `actors:
  alice:
    fundHbar: 3
steps:
  - actor: alice
    topicCreate: {}
assert: []
`,
    },
  );
  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.scenarios?.plan.steps[0].id, "step-1");
  assert.ok(spec.scenarios?.filePath?.endsWith("scenarios.yaml"));
});

test("scenarios without an operator source is rejected", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: no-op
${MINIMAL_BASELINE}
scenarios:
  enabled: true
  actors:
    alice:
      fundHbar: 1
  steps:
    - actor: alice
      topicCreate: {}
`);
  await assert.rejects(() => loadTemplateSpec(specPath), /requires operator/);
});

test("scenarios rejects mainnet", async () => {
  const specPath = await writeRecipe(`schemaVersion: 3
name: mainnet
${MINIMAL_BASELINE}
scenarios:
  enabled: true
  network: mainnet
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  actors:
    alice:
      fundHbar: 1
  steps:
    - actor: alice
      topicCreate: {}
`);
  await assert.rejects(() => loadTemplateSpec(specPath), /must be "testnet"/);
});
