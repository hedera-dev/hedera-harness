import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { checkChainCredentials, classifyPrivateKey, isAccountId, looksLikeEvmAddress } = await import(
  pathToFileURL(path.resolve("dist/chainCredentials.js")).href
);

const ECDSA_DER =
  
  "3030020100300706052b8104000a0422042000112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const ED25519_DER =
  "302e020100300506032b657004220420" + "11".repeat(32);
const RAW_HEX = "0x" + "ab".repeat(32);

function mirror({ status = 200, body = {} } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const base = {
  accountIdEnv: "OPERATOR_ID",
  privateKeyEnv: "OPERATOR_KEY",
  network: "testnet",
  fundingHbar: 10,
};

const find = (checks, name) => checks.find(c => c.name === name);

test("classifies key encodings without parsing them", () => {
  assert.equal(classifyPrivateKey(ECDSA_DER), "ecdsa");
  assert.equal(classifyPrivateKey(ED25519_DER), "ed25519");
  assert.equal(classifyPrivateKey(RAW_HEX), "raw");
  assert.equal(classifyPrivateKey("not-a-key"), "unknown");
});

test("distinguishes an account id from an EVM address", () => {
  assert.equal(isAccountId("0.0.12345"), true);
  assert.equal(isAccountId("0xe339e3e12df4b8cb04cc42d30e7898de0475b33b"), false);
  assert.equal(looksLikeEvmAddress("0xe339e3e12df4b8cb04cc42d30e7898de0475b33b"), true);
});

test("catches an EVM address pasted into the account id variable", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0xe339e3e12df4b8cb04cc42d30e7898de0475b33b", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: mirror(),
  });
  const account = find(checks, "operator account");
  assert.equal(account.status, "fail");
  assert.match(account.detail, /EVM address/);
});

test("catches a key whose curve does not match the account", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: ED25519_DER },
    fetchImpl: mirror({
      body: { account: "0.0.10391251", balance: { balance: 100_000_000_000 }, key: { _type: "ECDSA_SECP256K1" } },
    }),
  });
  const key = find(checks, "operator key");
  assert.equal(key.status, "fail");
  assert.match(key.detail, /ED25519 but .* is ECDSA_SECP256K1/);
});

test("tells you which fromString to use for a raw key", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: RAW_HEX },
    fetchImpl: mirror({
      body: { account: "0.0.10391251", balance: { balance: 100_000_000_000 }, key: { _type: "ECDSA_SECP256K1" } },
    }),
  });
  const key = find(checks, "operator key");
  assert.equal(key.status, "ok");
  assert.match(key.fix, /fromStringECDSA/);
});

test("fails when the account does not exist on the declared network", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.999999999", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: mirror({ status: 404 }),
  });
  const account = find(checks, "operator account");
  assert.equal(account.status, "fail");
  assert.match(account.detail, /does not exist on testnet/);
});

test("warns when the balance cannot cover what the run will fund", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: mirror({
      body: { account: "0.0.10391251", balance: { balance: 200_000_000 }, key: { _type: "ECDSA_SECP256K1" } },
    }),
  });
  const balance = find(checks, "operator balance");
  assert.equal(balance.status, "warn");
  assert.match(balance.detail, /run funds 10 plus fees/);
});

test("being offline is a warning, never a failure", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); },
  });
  assert.equal(find(checks, "mirror node").status, "warn");
  assert.ok(checks.every(c => c.status !== "fail"));
});

test("passes a correctly configured operator", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: mirror({
      body: { account: "0.0.10391251", balance: { balance: 100_000_000_000 }, key: { _type: "ECDSA_SECP256K1" } },
    }),
  });
  assert.ok(checks.every(c => c.status === "ok"), JSON.stringify(checks, null, 2));
});

test("never echoes the private key", async () => {
  const checks = await checkChainCredentials({
    ...base,
    env: { OPERATOR_ID: "0.0.10391251", OPERATOR_KEY: ECDSA_DER },
    fetchImpl: mirror({
      body: { account: "0.0.10391251", balance: { balance: 100_000_000_000 }, key: { _type: "ECDSA_SECP256K1" } },
    }),
  });
  const serialised = JSON.stringify(checks);
  assert.ok(!serialised.includes(ECDSA_DER.slice(-32)));
});
