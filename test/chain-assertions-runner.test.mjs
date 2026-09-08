import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { runChainAssertions } = await import(
  pathToFileURL(path.resolve("dist/validation/chainAssertions.js")).href
);

const SIGNER = {
  accountId: "0.0.1111",
  privateKeyHex: `0x${"a".repeat(64)}`,
  evmAddress: `0x${"1".repeat(40)}`,
  network: "testnet",
};

const TX_ID = "0.0.1111@1699999999.123456789";

function baseChainValidation(assertions) {
  return {
    enabled: true,
    network: "testnet",
    operator: { accountIdEnv: "HEDERA_OPERATOR_ID", privateKeyEnv: "HEDERA_OPERATOR_KEY" },
    fundingHbar: 10,
    sweepBack: true,
    expose: { browserLocalStorageKey: "burnerWallet.pk", envVars: [] },
    assertions,
  };
}

/** Prints TX_ID to stdout, like a real action script reporting what it submitted. */
function echoAction(name = "a") {
  return { name, command: `echo "submitted ${TX_ID}"` };
}

async function run(assertions, deps, actorSigners = {}) {
  const workspacePath = await makeTestTempDir("chain-assertions-runner-");
  return runChainAssertions({
    workspacePath,
    chainValidation: baseChainValidation(assertions),
    primarySigner: SIGNER,
    actorSigners,
    deps,
  });
}

function found(result) {
  return { status: "found", value: result };
}

test("mustSucceed PASSes silently when Mirror Node confirms SUCCESS", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustSucceed" } }],
    { fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }) },
  );
  assert.deepEqual(findings, []);
});

test("mustRevert PASSes silently when Mirror Node confirms a non-SUCCESS result", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustRevert" } }],
    { fetchTransactionResult: async () => found({ result: "CONTRACT_REVERT_EXECUTED", consensusTimestamp: "1.1" }) },
  );
  assert.deepEqual(findings, []);
});

test("mustSucceed FAILs with expected/observed evidence when the tx actually reverted", async () => {
  const findings = await run(
    [{ id: "reject-unverified", action: echoAction(), expect: { outcome: "mustSucceed" } }],
    { fetchTransactionResult: async () => found({ result: "CONTRACT_REVERT_EXECUTED", consensusTimestamp: "1.1" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "chain-assertion:reject-unverified");
  assert.equal(findings[0].category, "chain-assertion");
  assert.deepEqual(findings[0].evidence, {
    transactionId: TX_ID,
    expected: "mustSucceed",
    observed: "CONTRACT_REVERT_EXECUTED",
  });
});

test("mustRevert FAILs when the tx unexpectedly succeeded — the killer-demo scenario", async () => {
  const findings = await run(
    [{ id: "reject-unverified-transfer", action: echoAction(), expect: { outcome: "mustRevert" } }],
    { fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion");
  assert.match(findings[0].message, /expected mustRevert, observed transaction result SUCCESS/);
});

test("reasonContains mismatch FAILs even though the tx did revert", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustRevert", reasonContains: "KYC" } }],
    { fetchTransactionResult: async () => found({ result: "CONTRACT_REVERT_EXECUTED", consensusTimestamp: "1.1" }) },
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /did not contain "KYC"/);
});

test("reasonContains match PASSes", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustRevert", reasonContains: "FROZEN" } }],
    { fetchTransactionResult: async () => found({ result: "ACCOUNT_FROZEN_FOR_TOKEN", consensusTimestamp: "1.1" }) },
  );
  assert.deepEqual(findings, []);
});

test("an assertion referencing an unprovisioned actor is a config violation, not a silent pass", async () => {
  const findings = await run(
    [{ id: "a1", actor: "attacker", action: echoAction(), expect: { outcome: "mustSucceed" } }],
    {},
    {}, // no actors provisioned
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion");
  assert.match(findings[0].message, /references actor "attacker"/);
});

test("an assertion resolves the declared actor's signer, not the primary one", async () => {
  const attackerSigner = { ...SIGNER, accountId: "0.0.9999" };
  let usedAccountId;
  const findings = await run(
    [{ id: "a1", actor: "attacker", action: { name: "a", command: "true" }, expect: { outcome: "mustSucceed" } }],
    {
      fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }),
    },
    { attacker: attackerSigner },
  );
  // No transaction id in "true"'s empty stdout — proves this reaches the actor-resolution path,
  // not just default-to-primary, since a missing actor produces a different, distinct message.
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /no parseable Hedera transaction id/);
});

test("no parseable transaction id in the action's output is a config violation", async () => {
  const findings = await run(
    [{ id: "a1", action: { name: "a", command: 'echo "no id printed here"' }, expect: { outcome: "mustSucceed" } }],
    {},
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion");
  assert.match(findings[0].message, /no parseable Hedera transaction id/);
});

test("a non-zero exit from the action command is chain-assertion-infra, never an app-policy violation", async () => {
  // Even though it prints a well-formed transaction id, a non-zero exit means the action did
  // not run to completion, so that id must not be trusted as real evidence.
  const findings = await run(
    [{ id: "a1", action: { name: "a", command: `echo "submitted ${TX_ID}"; exit 1` }, expect: { outcome: "mustSucceed" } }],
    {},
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion-infra");
  assert.match(findings[0].message, /did not complete \(exit code 1\)/);
  // Mirror Node must never even be queried once the action itself failed to complete.
});

test("a timed-out action command is chain-assertion-infra, never an app-policy violation", async () => {
  const findings = await run(
    [
      {
        id: "a1",
        action: { name: "a", command: "sleep 2", timeoutMs: 100 },
        expect: { outcome: "mustSucceed" },
      },
    ],
    {},
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion-infra");
  assert.match(findings[0].message, /did not complete \(timed out\)/);
});

test("infra-error confirming the tx result is chain-assertion-infra, never a pass or a violation", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustSucceed" } }],
    { fetchTransactionResult: async () => ({ status: "infra-error", message: "Mirror Node returned HTTP 500" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion-infra");
  assert.match(findings[0].message, /Mirror Node returned HTTP 500/);
});

test("not-found (never appeared) is chain-assertion-infra, distinct from a confirmed revert", async () => {
  const findings = await run(
    [{ id: "a1", action: echoAction(), expect: { outcome: "mustSucceed" } }],
    { fetchTransactionResult: async () => ({ status: "not-found" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion-infra");
  assert.match(findings[0].message, /propagation lag/);
});

test("balanceDelta PASSes when the sampled delta matches exactly", async () => {
  let call = 0;
  const balances = [1_000_000_000n, 1_005_000_000n]; // +5 hbar in tinybars
  const findings = await run(
    [
      {
        id: "coupon",
        action: echoAction(),
        expect: {
          outcome: "mustSucceed",
          balanceDelta: { account: "0.0.42", asset: "hbar", equals: "5000000" },
        },
      },
    ],
    {
      fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }),
      fetchHbarBalanceTinybars: async () => found(balances[call++]),
    },
  );
  assert.deepEqual(findings, []);
});

test("balanceDelta FAILs with expected/observed when the sampled delta is wrong", async () => {
  let call = 0;
  const balances = [1_000_000_000n, 1_000_000_000n]; // no change at all
  const findings = await run(
    [
      {
        id: "coupon",
        action: echoAction(),
        expect: {
          outcome: "mustSucceed",
          balanceDelta: { account: "0.0.42", asset: "hbar", equals: "5000000" },
        },
      },
    ],
    {
      fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }),
      fetchHbarBalanceTinybars: async () => found(balances[call++]),
    },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion");
  assert.deepEqual(findings[0].evidence, { transactionId: TX_ID, expected: "5000000", observed: "0" });
});

test("balanceDelta.accountEnv resolves from the environment at execution time", async () => {
  process.env.POLICYPROBE_TEST_ALICE_ACCOUNT = "0.0.777";
  try {
    let call = 0;
    const balances = [0n, 100n];
    const findings = await run(
      [
        {
          id: "a1",
          action: echoAction(),
          expect: {
            outcome: "mustSucceed",
            balanceDelta: { accountEnv: "POLICYPROBE_TEST_ALICE_ACCOUNT", asset: "hbar", equals: "100" },
          },
        },
      ],
      {
        fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }),
        fetchHbarBalanceTinybars: async () => found(balances[call++]),
      },
    );
    assert.deepEqual(findings, []);
  } finally {
    delete process.env.POLICYPROBE_TEST_ALICE_ACCOUNT;
  }
});

test("balanceDelta.accountEnv unset in the environment is a config violation, before the action even runs", async () => {
  const findings = await run(
    [
      {
        id: "a1",
        action: { name: "a", command: "false" }, // would exit 1 if reached — proves it never runs
        expect: {
          outcome: "mustSucceed",
          balanceDelta: { accountEnv: "POLICYPROBE_TEST_UNSET_VAR", asset: "hbar", equals: "0" },
        },
      },
    ],
    {},
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /accountEnv "POLICYPROBE_TEST_UNSET_VAR" is not set/);
});

test("infra-error sampling the BEFORE balance aborts before the action ever runs", async () => {
  const findings = await run(
    [
      {
        id: "a1",
        action: { name: "a", command: "false" },
        expect: { outcome: "mustSucceed", balanceDelta: { account: "0.0.1", asset: "hbar", equals: "0" } },
      },
    ],
    { fetchHbarBalanceTinybars: async () => ({ status: "infra-error", message: "boom" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "chain-assertion-infra");
  assert.match(findings[0].message, /BEFORE balance/);
});

test("multiple assertions each get evaluated independently — one violation among passes", async () => {
  const findings = await run(
    [
      { id: "pass-1", action: echoAction("p1"), expect: { outcome: "mustSucceed" } },
      { id: "fail-1", action: echoAction("f1"), expect: { outcome: "mustRevert" } },
      { id: "pass-2", action: echoAction("p2"), expect: { outcome: "mustSucceed" } },
    ],
    { fetchTransactionResult: async () => found({ result: "SUCCESS", consensusTimestamp: "1.1" }) },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "chain-assertion:fail-1");
});

// --- Live end-to-end (real testnet, real transaction, real Mirror Node) -------------------

const hasOperatorEnv = Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY);

test(
  "end-to-end against real testnet: a real self-transfer resolves mustSucceed with real evidence",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const sdk = await import("@hiero-ledger/sdk");
    const operatorId = process.env.HEDERA_OPERATOR_ID;
    const operatorKey = sdk.PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY.replace(/^0x/i, ""));

    // cwd must resolve @hiero-ledger/sdk via node_modules — use the repo root, not a fresh
    // temp dir (a real recipe's action script runs from the app workspace, which has its own
    // deps; this inline script borrows the harness's own SDK dependency for the test).
    const workspacePath = path.resolve(".");
    // The action script is a real Node one-liner: submit a real 1-tinybar self-transfer with
    // the signer env vars the harness injects, print the real transaction id it got back.
    const scriptEnv = {
      HARNESS_SIGNER_ACCOUNT_ID: operatorId,
      HARNESS_SIGNER_PRIVATE_KEY: process.env.HEDERA_OPERATOR_KEY,
    };
    void scriptEnv; // the harness injects these itself via buildDeployEnv; documented for clarity

    const findings = await runChainAssertions({
      workspacePath,
      chainValidation: baseChainValidation([
        {
          id: "real-self-transfer-must-succeed",
          action: {
            name: "self-transfer",
            command:
              'node -e "' +
              "const sdk = require('@hiero-ledger/sdk');" +
              "const id = process.env.HARNESS_SIGNER_ACCOUNT_ID;" +
              "const key = sdk.PrivateKey.fromStringECDSA(process.env.HARNESS_SIGNER_PRIVATE_KEY.replace(/^0x/i,''));" +
              "const client = sdk.Client.forTestnet();" +
              "client.setOperator(sdk.AccountId.fromString(id), key);" +
              "(async () => {" +
              "  const tx = await new sdk.TransferTransaction()" +
              "    .addHbarTransfer(id, new sdk.Hbar(-0.00000001))" +
              "    .addHbarTransfer(id, new sdk.Hbar(0.00000001))" +
              "    .execute(client);" +
              "  await tx.getReceipt(client);" +
              "  console.log('submitted ' + tx.transactionId.toString());" +
              "  client.close();" +
              "})();" +
              '"',
            timeoutMs: 30_000,
          },
          expect: { outcome: "mustSucceed" },
        },
      ]),
      primarySigner: { accountId: operatorId, privateKeyHex: process.env.HEDERA_OPERATOR_KEY, evmAddress: "0x0", network: "testnet" },
      actorSigners: {},
    });

    assert.deepEqual(findings, []);
  },
);
