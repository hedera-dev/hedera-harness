import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const store = await import(pathToFileURL(path.resolve("dist/wallet/store.js")).href);
const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const runtime = await import(pathToFileURL(path.resolve("dist/wallet/runtime.js")).href);
const constants = await import(pathToFileURL(path.resolve("dist/wallet/constants.js")).href);

test("parseCliArgs accepts wallet init/status/demo", () => {
  const init = cli.parseCliArgs(["wallet", "init", "--hbar-target", "5"]);
  assert.equal(init.command, "wallet");
  assert.equal(init.walletOptions?.subcommand, "init");
  assert.equal(init.walletOptions?.hbarTarget, 5);

  const status = cli.parseCliArgs(["wallet", "status"]);
  assert.equal(status.walletOptions?.subcommand, "status");

  const demo = cli.parseCliArgs(["wallet", "demo", "--asset", "hbar", "--headless"]);
  assert.equal(demo.walletOptions?.subcommand, "demo");
  assert.equal(demo.walletOptions?.asset, "hbar");
  assert.equal(demo.walletOptions?.headed, false);
});

test("parseCliArgs rejects unknown wallet subcommand", () => {
  assert.throws(() => cli.parseCliArgs(["wallet", "explode"]), /init", "status", or "demo"/);
});

test("saveWallet + loadWallet round-trip reuses the same account", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-wallet-store-"));
  const wallet = {
    accountId: "0.0.9123456",
    privateKeyHex: "0x" + "11".repeat(32),
    publicKeyHex: "22".repeat(33),
    network: "testnet",
    createdAt: new Date().toISOString(),
  };

  const persistPath = await store.saveWallet(dir, wallet);
  const raw = await readFile(persistPath, "utf8");
  assert.match(raw, /0\.0\.9123456/);

  const loaded = await store.loadWallet(dir);
  assert.equal(loaded?.accountId, "0.0.9123456");
  assert.equal(loaded?.network, "testnet");
  assert.equal(loaded?.privateKeyHex, wallet.privateKeyHex);

  const again = await store.loadWallet(dir);
  assert.equal(again?.accountId, loaded?.accountId);
});

test("assertTestnetOnly hard-fails mainnet", () => {
  assert.throws(() => store.assertTestnetOnly("mainnet"), /only supports Hedera testnet/);
});

test("wallet runtime exposes approve/sign boundary without leaking key", async () => {
  const wallet = {
    accountId: "0.0.9123456",
    privateKeyHex: "0x" + "33".repeat(32),
    publicKeyHex: "44".repeat(33),
    network: "testnet",
    createdAt: new Date().toISOString(),
  };

  const handle = await runtime.startWalletRuntime({
    wallet,
    projectId: "test",
    preferWalletKit: false,
  });

  try {
    const health = await (await fetch(`${handle.baseUrl}/health`)).json();
    assert.equal(health.ok, true);

    const pairPromise = handle.submitPairingUri("wc:demo@2?relay-protocol=harness&symKey=abc");
    // Allow pending state to publish.
    await new Promise(r => setTimeout(r, 50));
    let state = handle.state();
    assert.equal(state.pending?.kind, "session_proposal");
    assert.equal(state.extensionId, constants.HARNESS_WALLET_EXTENSION_ID);
    assert.ok(!JSON.stringify(state).includes(wallet.privateKeyHex.slice(2)));

    const approve = await (
      await fetch(`${handle.baseUrl}/approve`, { method: "POST" })
    ).json();
    assert.equal(approve.paired, true);
    await pairPromise;

    state = handle.state();
    assert.equal(state.paired, true);
    assert.equal(state.pending, null);
  } finally {
    await handle.close();
  }
});
