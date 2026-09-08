import assert from "node:assert/strict";
import path from "node:path";
import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { provisionChainActor, sweepChainSigner, chainActorFilename } = await import(
  pathToFileURL(path.resolve("dist/validation/chainSigner.js")).href
);

// Real Hedera testnet calls — needs a funded ECDSA operator. Skip gracefully rather than
// fail CI/other machines that don't have HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY exported.
// See docs/authoring-a-recipe.md CHAIN section and policy-probe/docs/MANUAL_ACTIONS.md.
const hasOperatorEnv = Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY);

const config = {
  enabled: true,
  network: "testnet",
  operator: { accountIdEnv: "HEDERA_OPERATOR_ID", privateKeyEnv: "HEDERA_OPERATOR_KEY" },
  fundingHbar: 10,
  sweepBack: true,
  expose: { browserLocalStorageKey: "burnerWallet.pk", envVars: [] },
};

test(
  "provisionChainActor creates a funded, independent account from the primary signer's file",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const runDirectory = await makeTestTempDir("chain-actor-");

    const provisioned = await provisionChainActor("attacker", 1, config, runDirectory);
    assert.equal(provisioned.reused, false);
    assert.match(provisioned.signer.accountId, /^0\.0\.\d+$/);
    assert.equal(provisioned.signer.network, "testnet");

    // Persisted under its own file, independent of chain-signer.json.
    await access(path.join(runDirectory, chainActorFilename("attacker")));

    // Reprovisioning the same actor reuses the persisted account rather than creating a new one.
    const reprovisioned = await provisionChainActor("attacker", 1, config, runDirectory);
    assert.equal(reprovisioned.reused, true);
    assert.equal(reprovisioned.signer.accountId, provisioned.signer.accountId);

    const sweep = await sweepChainSigner(
      provisioned.signer,
      config,
      path.join(runDirectory, chainActorFilename("attacker")),
    );
    assert.equal(sweep.success, true);
    await assert.rejects(() => access(path.join(runDirectory, chainActorFilename("attacker"))));
  },
);

test(
  "two different actors get two different accounts",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const runDirectory = await makeTestTempDir("chain-actor-");

    const alice = await provisionChainActor("alice", 1, config, runDirectory);
    const bob = await provisionChainActor("bob", 1, config, runDirectory);
    assert.notEqual(alice.signer.accountId, bob.signer.accountId);

    await sweepChainSigner(alice.signer, config, path.join(runDirectory, chainActorFilename("alice")));
    await sweepChainSigner(bob.signer, config, path.join(runDirectory, chainActorFilename("bob")));
  },
);
