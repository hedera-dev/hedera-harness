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

/** Write a recipe and the files the loader's preflight expects to exist. */
async function writeRecipe(body, { prefix = "chain-assertions-" } = {}) {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "spec.yaml"), body);
  return { specPath: path.join(root, ".harness", "spec.yaml") };
}

const CHAIN_VALIDATION_HEADER = `chainValidation:
  enabled: true
  network: testnet
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
`;

test("chainValidation.actors and .assertions are undefined when omitted (backward compatible)", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}`);

  const { spec } = await loadTemplateSpec(specPath);

  assert.equal(spec.chainValidation.actors, undefined);
  assert.equal(spec.chainValidation.assertions, undefined);
});

test("a full actors + assertions block parses into the expected shape", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  actors:
    attacker:
      fundingHbar: 5
    complianceOfficer: {}
  assertions:
    - id: reject-unverified-transfer
      description: "Unverified investor must not receive the bond"
      actor: attacker
      action:
        name: attempt-transfer-to-bob
        command: "yarn hardhat run scripts/transfer-to-bob.ts"
        timeoutMs: 60000
      expect:
        outcome: mustRevert
        reasonContains: KYC
    - id: coupon-balance-delta
      action:
        name: run-coupon
        command: "yarn hardhat run scripts/pay-coupon.ts"
      expect:
        outcome: mustSucceed
        balanceDelta:
          accountEnv: ALICE_ACCOUNT_ID
          asset: hbar
          equals: "500000000"
`);

  const { spec } = await loadTemplateSpec(specPath);
  const { actors, assertions } = spec.chainValidation;

  assert.deepEqual(actors, { attacker: { fundingHbar: 5 }, complianceOfficer: {} });
  assert.equal(assertions.length, 2);

  const [reject, coupon] = assertions;
  assert.equal(reject.id, "reject-unverified-transfer");
  assert.equal(reject.actor, "attacker");
  assert.equal(reject.action.command, "yarn hardhat run scripts/transfer-to-bob.ts");
  assert.equal(reject.expect.outcome, "mustRevert");
  assert.equal(reject.expect.reasonContains, "KYC");
  assert.equal(reject.expect.balanceDelta, undefined);

  assert.equal(coupon.actor, undefined);
  assert.equal(coupon.expect.outcome, "mustSucceed");
  assert.deepEqual(coupon.expect.balanceDelta, {
    account: undefined,
    accountEnv: "ALICE_ACCOUNT_ID",
    asset: "hbar",
    equals: "500000000",
  });
});

test("an assertion referencing an undeclared actor is rejected at load", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: reject-unverified-transfer
      actor: attacker
      action: { name: a, command: "true" }
      expect: { outcome: mustRevert }
`);

  await assert.rejects(() => loadTemplateSpec(specPath), /references actor "attacker".*not declared/s);
});

test("duplicate assertion ids are rejected at load", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: dup
      action: { name: a, command: "true" }
      expect: { outcome: mustSucceed }
    - id: dup
      action: { name: b, command: "true" }
      expect: { outcome: mustSucceed }
`);

  await assert.rejects(() => loadTemplateSpec(specPath), /Duplicate chainValidation\.assertions id "dup"/);
});

test("an unknown expect.outcome is rejected at load", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: bad-outcome
      action: { name: a, command: "true" }
      expect: { outcome: mustMaybe }
`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    /expect\.outcome must be "mustSucceed" or "mustRevert"/,
  );
});

test("reasonContains on a mustSucceed assertion is rejected — it only narrows a revert", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: bad-reason
      action: { name: a, command: "true" }
      expect: { outcome: mustSucceed, reasonContains: "whatever" }
`);

  await assert.rejects(() => loadTemplateSpec(specPath), /reasonContains only applies to mustRevert/);
});

test("balanceDelta requires exactly one of account/accountEnv", async () => {
  const neither = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: neither
      action: { name: a, command: "true" }
      expect: { outcome: mustSucceed, balanceDelta: { asset: hbar, equals: "0" } }
`);
  await assert.rejects(
    () => loadTemplateSpec(neither.specPath),
    /needs exactly one of "account" or "accountEnv"/,
  );

  const both = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: both
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", accountEnv: "X", asset: hbar, equals: "0" }
`);
  await assert.rejects(
    () => loadTemplateSpec(both.specPath),
    /needs exactly one of "account" or "accountEnv"/,
  );
});

test("balanceDelta.asset must be hbar or a tokenId object", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: bad-asset
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", asset: "eth", equals: "0" }
`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    /asset must be "hbar", \{ tokenId: "0\.0\.x" \}, or \{ contract: "0x\.\.\." \}/,
  );
});

test("balanceDelta.asset accepts a contract address for an EVM/Solidity token", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: contract-balance
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0xff1bdea3dca4c5889dde6ea61a3ce2d2ed84960a", asset: { contract: "0x19CD7866076758E3AF6C79aD7Ce725331A5606B8" }, equals: "100" }
`);

  const { spec } = await loadTemplateSpec(specPath);
  assert.deepEqual(spec.chainValidation.assertions[0].expect.balanceDelta.asset, {
    contract: "0x19CD7866076758E3AF6C79aD7Ce725331A5606B8",
  });
});

test("balanceDelta.asset object with neither tokenId nor contract is rejected", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: bad-asset-shape
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", asset: { foo: "bar" }, equals: "0" }
`);

  await assert.rejects(
    () => loadTemplateSpec(specPath),
    /asset object must be \{ tokenId: "0\.0\.x" \} or \{ contract: "0x\.\.\." \}/,
  );
});

test("a tokenId asset parses correctly", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: token-delta
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", asset: { tokenId: "0.0.7777" }, equals: "-100" }
`);

  const { spec } = await loadTemplateSpec(specPath);
  assert.deepEqual(spec.chainValidation.assertions[0].expect.balanceDelta.asset, {
    tokenId: "0.0.7777",
  });
});

test("balanceDelta.equals rejects non-integer strings at load, before they ever reach BigInt()", async () => {
  for (const badValue of ["5.5e8", "500,000,000", "5.5", "not-a-number"]) {
    const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: bad-equals
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", asset: hbar, equals: ${JSON.stringify(badValue)} }
`);

    await assert.rejects(
      () => loadTemplateSpec(specPath),
      /expect\.balanceDelta\.equals must be a signed integer string/,
      `expected ${JSON.stringify(badValue)} to be rejected`,
    );
  }
});

test("balanceDelta.equals accepts negative integers", async () => {
  const { specPath } = await writeRecipe(`schemaVersion: 3
name: my-feature
${MINIMAL_BASELINE}${CHAIN_VALIDATION_HEADER}  assertions:
    - id: negative-equals
      action: { name: a, command: "true" }
      expect:
        outcome: mustSucceed
        balanceDelta: { account: "0.0.1", asset: hbar, equals: "-500000000" }
`);

  const { spec } = await loadTemplateSpec(specPath);
  assert.equal(spec.chainValidation.assertions[0].expect.balanceDelta.equals, "-500000000");
});
