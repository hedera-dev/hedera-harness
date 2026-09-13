import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const tokens = await import(pathToFileURL(path.resolve("dist/tokenRegistry.js")).href);

test("testnet USDC is Circle 0.0.429274 long-zero", () => {
  const printed = tokens.formatTokenLookup("USDC", "testnet");
  assert.match(printed, /hts_id=0\.0\.429274/);
  assert.match(printed, /evm=0x0000000000000000000000000000000000068cda/);
  assert.match(printed, /chain_id=296/);
  assert.doesNotMatch(printed, /token=lookup/);
});

test("mainnet USDC matches SaucerSwap / Circle 0.0.456858", () => {
  const token = tokens.resolveListedToken("USDC", "mainnet");
  assert.equal(token?.htsId, "0.0.456858");
  assert.equal(token?.evm, "0x000000000000000000000000000000000006f89a");
});

test("htsTokenNumToEvmAddress pads to 20 bytes", () => {
  assert.equal(tokens.htsTokenNumToEvmAddress(429274), "0x0000000000000000000000000000000000068cda");
  assert.equal(tokens.htsTokenNumToEvmAddress(77), "0x000000000000000000000000000000000000004d");
});

test("unknown symbol is lookup, not invented", () => {
  const printed = tokens.formatTokenLookup("USDT", "testnet");
  assert.match(printed, /token=lookup/);
  assert.match(printed, /SearchHedera/i);
  assert.match(printed, /webfetch=/);
  assert.doesNotMatch(printed, /^evm=/m);
});

test("convert prints HIP-218 facade", () => {
  const printed = tokens.formatConvertHtsId("0.0.429274", "testnet");
  assert.match(printed, /evm=0x0000000000000000000000000000000000068cda/);
});

test("remember writes workspace tokens and lookup hits them", async () => {
  const root = await makeTestTempDir("tokens-remember-");
  const saved = tokens.formatRememberWorkspaceToken(root, {
    symbol: "USDT",
    network: "testnet",
    htsId: "0.0.42",
    source: "webfetch:hashscan",
  });
  assert.match(saved, /token=USDT/);
  assert.match(saved, /evm=0x000000000000000000000000000000000000002a/);
  const file = path.join(root, ".harness", "tokens.json");
  const body = JSON.parse(await readFile(file, "utf8"));
  assert.equal(body.tokens[0].symbol, "USDT");
  const lookup = tokens.formatTokenLookup("USDT", "testnet", root);
  assert.match(lookup, /token=USDT/);
  assert.match(lookup, /evm=0x000000000000000000000000000000000000002a/);
});
