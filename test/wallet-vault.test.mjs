import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const vault = await import(pathToFileURL(path.resolve("dist/walletVault.js")).href);
const page = await import(pathToFileURL(path.resolve("dist/walletProvisionPage.js")).href);
const serverMod = await import(pathToFileURL(path.resolve("dist/walletProvisionServer.js")).href);
const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);

const TEST_KEY = "ab".repeat(32);

test("parseCliArgs accepts wallet status and provision --no-open", () => {
  const status = cli.parseCliArgs(["wallet", "status", "--workspace", "D:\\app"]);
  assert.equal(status.command, "wallet");
  assert.equal(status.walletOptions?.subcommand, "status");
  assert.equal(status.walletOptions?.workspace, "D:\\app");

  const provision = cli.parseCliArgs(["wallet", "provision", "--no-open", "--port", "17373"]);
  assert.equal(provision.walletOptions?.subcommand, "provision");
  assert.equal(provision.walletOptions?.open, false);
  assert.equal(provision.walletOptions?.port, 17373);

  const e2e = cli.parseCliArgs(["wallet", "e2e", "--url", "http://127.0.0.1:3000"]);
  assert.equal(e2e.walletOptions?.subcommand, "e2e");
  assert.equal(e2e.walletOptions?.url, "http://127.0.0.1:3000");

  const send = cli.parseCliArgs([
    "wallet",
    "e2e",
    "--url",
    "http://127.0.0.1:3000",
    "--amount",
    "1",
    "--to",
    "0xf87445ba6b780706d332db3a85d5f750232781a8",
  ]);
  assert.equal(send.walletOptions?.amount, "1");
  assert.equal(send.walletOptions?.to, "0xf87445ba6b780706d332db3a85d5f750232781a8");
});

test("normalizeE2eAmount keeps 1 HBAR and defaults smoke to 0.01", async () => {
  const e2e = await import(pathToFileURL(path.resolve("dist/walletE2e.js")).href);
  assert.equal(e2e.normalizeE2eAmount("1").amount, "1");
  assert.equal(e2e.normalizeE2eAmount().amount, "0.01");
  assert.equal(e2e.normalizeE2eAmount("nope").invalid, "nope");
  assert.equal(e2e.normalizeE2eTo("0xf87445ba6b780706d332db3a85d5f750232781a8").length, 42);
  assert.equal(e2e.normalizeE2eTo("not-an-address"), "");
});

test("inspectWalletReady is false until a valid vault exists", async () => {
  const root = await makeTestTempDir("wallet-empty-");
  const before = vault.inspectWalletReady(root);
  assert.equal(before.ready, false);
  assert.match(before.reason, /never paste a key in chat/i);
  assert.doesNotMatch(vault.formatWalletStatus(before), /0x/i);
});

test("writeVaultFile persists test vault and status never prints the key", async () => {
  const root = await makeTestTempDir("wallet-write-");
  vault.writeVaultFile(root, { password: "testpass1", privateKey: TEST_KEY });
  const after = vault.inspectWalletReady(root);
  assert.equal(after.ready, true);
  const printed = vault.formatWalletStatus(after);
  assert.doesNotMatch(printed, new RegExp(TEST_KEY));
  assert.match(printed, /never_ask_in_chat=true/);
  assert.match(printed, /metamask=pending/);
  assert.match(printed, /workspace=/);
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
  assert.match(gitignore, /\.harness\/wallet\//);
});

test("imported marker is secret-free and flips status to metamask=imported", async () => {
  const root = await makeTestTempDir("wallet-imported-");
  vault.writeVaultFile(root, { password: "testpass1", privateKey: TEST_KEY });
  vault.writeMetaMaskImportedMarker(root);
  const printed = vault.formatWalletStatus(vault.inspectWalletReady(root));
  assert.match(printed, /metamask=imported/);
  assert.doesNotMatch(printed, new RegExp(TEST_KEY));
  const marker = await readFile(path.join(root, ".harness", "wallet", "metamask-imported.json"), "utf8");
  assert.doesNotMatch(marker, new RegExp(TEST_KEY));
  assert.doesNotMatch(marker, /password/i);
});

test("provision page tells the human to use a testnet portal key", () => {
  const html = page.walletProvisionPageHtml();
  assert.match(html, /TESTNET ONLY/);
  assert.match(html, /portal\.hedera\.com/);
  assert.match(html, /not paste the key in chat/);
});

test("provision server saves vault and response has no private key", async () => {
  const root = await makeTestTempDir("wallet-http-");
  const server = await serverMod.startWalletProvisionServer(root);
  try {
    const res = await fetch(new URL("/save", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "testpass1", privateKey: `0x${TEST_KEY}` }),
    });
    const text = await res.text();
    assert.equal(res.ok, true);
    assert.match(text, /Saved/);
    assert.doesNotMatch(text, new RegExp(TEST_KEY));
    await server.saved;
    assert.equal(vault.inspectWalletReady(root).ready, true);
  } finally {
    await server.close();
  }
});

const metamask = await import(pathToFileURL(path.resolve("dist/walletMetaMask.js")).href);

test("privateKeyForImport strips 0x and never logs the key in browser status text", () => {
  const hex = metamask.privateKeyForImport(`0x${TEST_KEY}`);
  assert.equal(hex, TEST_KEY);
  assert.equal(metamask.isBenignImportError(new Error("Account already imported")), true);
  assert.equal(metamask.isBenignImportError(new Error("Failed to import")), false);
  const log = metamask.formatWalletBrowserLog({
    firstRun: true,
    profile: "C:\\\\app\\\\.harness\\\\wallet\\\\chrome-profile",
    metamaskVersion: "13.17.0",
  });
  assert.match(log, /import=running/);
  assert.match(log, /dappwright/);
  assert.doesNotMatch(log, new RegExp(TEST_KEY));
  assert.doesNotMatch(log, /0x[a-f0-9]{64}/i);
});

test("detectLiveAppUrl returns a listening local server", async () => {
  const e2e = await import(pathToFileURL(path.resolve("dist/walletE2e.js")).href);
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const url = await e2e.detectLiveAppUrl(`http://127.0.0.1:${port}`);
    assert.equal(url, `http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
