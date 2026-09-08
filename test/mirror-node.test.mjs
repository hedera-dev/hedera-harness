import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { verifyOnChainActivity, readSignerTransactions, summarizeChainActivity, mirrorNodeUrlFor } =
  await import(pathToFileURL(path.resolve("dist/validation/mirrorNode.js")).href);

const ACCOUNT = "0.0.10418423";

/** A mirror-node transaction as the REST API returns it. */
const tx = (overrides = {}) => ({
  transaction_id: "0.0.10418423-1788858107-062291812",
  name: "CRYPTOTRANSFER",
  result: "SUCCESS",
  consensus_timestamp: "1788858113.004209110",
  entity_id: null,
  charged_tx_fee: 249337,
  ...overrides,
});

/** A fetch stand-in that serves one fixed page of transactions. */
const fetchReturning = (transactions, { ok = true, status = 200 } = {}) => {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    return { ok, status, json: async () => ({ transactions }) };
  };
  impl.calls = calls;
  return impl;
};

const fetchThatThrows = (message) => async () => {
  throw new Error(message);
};

const base = { accountId: ACCOUNT, timeoutMs: 50, pollMs: 5 };

test("mirrorNodeUrlFor knows the public networks", () => {
  assert.equal(mirrorNodeUrlFor("testnet"), "https://testnet.mirrornode.hedera.com");
  assert.equal(mirrorNodeUrlFor("mainnet"), "https://mainnet-public.mirrornode.hedera.com");
  assert.equal(mirrorNodeUrlFor(), "https://testnet.mirrornode.hedera.com");
});

test("a successful transaction produces no findings", async () => {
  const result = await verifyOnChainActivity({ ...base, fetchImpl: fetchReturning([tx()]) });

  assert.equal(result.reachable, true);
  assert.equal(result.transactions.length, 1);
  assert.deepEqual(result.findings, []);
  assert.equal(result.transactions[0].chargedFeeHbar, 0.00249337);
});

test("a consensus failure behind exit code 0 is caught and named", async () => {
  const result = await verifyOnChainActivity({
    ...base,
    fetchImpl: fetchReturning([
      tx({ name: "CONTRACTCREATEINSTANCE", result: "CONTRACT_REVERT_EXECUTED" }),
    ]),
  });

  assert.equal(result.failures.length, 1);
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.category, "commands");
  assert.match(finding.message, /CONTRACT_REVERT_EXECUTED/);
  assert.match(finding.details, /execute\(\) only pre-checks/);
});

test("a deploy that submitted nothing fails even though the command exited 0", async () => {
  const result = await verifyOnChainActivity({ ...base, fetchImpl: fetchReturning([]) });

  assert.equal(result.reachable, true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, "chain-verify:no-transactions");
  assert.equal(result.findings[0].category, "commands");
});

test("an unreachable mirror node is infrastructure, not an app defect", async () => {
  const result = await verifyOnChainActivity({
    ...base,
    fetchImpl: fetchThatThrows("ECONNREFUSED"),
  });

  assert.equal(result.reachable, false);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, "semantic-infra");
  assert.match(result.findings[0].message, /Mirror node unreachable/);
  // The app must not be blamed for an outage.
  assert.equal(result.findings.some((f) => f.category === "commands"), false);
});

test("an HTTP error from the mirror node is also infrastructure", async () => {
  const result = await verifyOnChainActivity({
    ...base,
    fetchImpl: fetchReturning([], { ok: false, status: 503 }),
  });

  assert.equal(result.reachable, false);
  assert.equal(result.findings[0].category, "semantic-infra");
  assert.match(result.findings[0].details, /503/);
});

test("transactions before the run window are not credited to it", async () => {
  const fetchImpl = fetchReturning([
    tx({ consensus_timestamp: "1788858000.000000000" }), // before
    tx({ consensus_timestamp: "1788858200.000000000" }), // after
  ]);

  const result = await verifyOnChainActivity({
    ...base,
    since: "1788858100.000000000",
    fetchImpl,
  });

  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].consensusTimestamp, "1788858200.000000000");
});

test("created entities are reported, and only for successful creates", async () => {
  const result = await verifyOnChainActivity({
    ...base,
    fetchImpl: fetchReturning([
      tx({ name: "CONTRACTCREATEINSTANCE", entity_id: "0.0.5001" }),
      tx({ name: "TOKENCREATION", entity_id: "0.0.5002" }),
      tx({ name: "CONTRACTCREATEINSTANCE", entity_id: "0.0.5003", result: "INSUFFICIENT_GAS" }),
    ]),
  });

  assert.deepEqual(result.entitiesCreated, ["0.0.5001", "0.0.5002"]);
  assert.equal(result.failures.length, 1);
});

test("the signer's account is what gets queried, newest first", async () => {
  const fetchImpl = fetchReturning([tx()]);
  await verifyOnChainActivity({ ...base, fetchImpl });

  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.match(url, /\/api\/v1\/transactions\?/);
  assert.match(url, /account\.id=0\.0\.10418423/);
  // order=desc is required, not cosmetic: with order=asc and no timestamp bound
  // the mirror node scans from ledger genesis and returns an empty page for an
  // account that has transactions.
  assert.match(url, /order=desc/);
});

test("a run window is bounded server-side so genesis is never scanned", async () => {
  const fetchImpl = fetchReturning([tx()]);
  await verifyOnChainActivity({ ...base, since: "1788858100.000000000", fetchImpl });

  const url = decodeURIComponent(fetchImpl.calls[0]);
  assert.match(url, /timestamp=gte:1788858100\.000000000/);
});

test("readSignerTransactions polls until a transaction appears", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ transactions: attempts >= 3 ? [tx()] : [] }),
    };
  };

  const result = await readSignerTransactions({
    accountId: ACCOUNT,
    timeoutMs: 5_000,
    pollMs: 1,
    fetchImpl,
  });

  assert.equal(result.reachable, true);
  assert.equal(result.transactions.length, 1);
  assert.ok(attempts >= 3, `expected polling, saw ${attempts} attempt(s)`);
});

test("summarizeChainActivity is one honest line in every state", async () => {
  const ok = await verifyOnChainActivity({
    ...base,
    fetchImpl: fetchReturning([tx({ name: "CONTRACTCREATEINSTANCE", entity_id: "0.0.5001" })]),
  });
  assert.match(summarizeChainActivity(ok), /1 tx.*created 0\.0\.5001.*ℏ in fees/);

  const empty = await verifyOnChainActivity({ ...base, fetchImpl: fetchReturning([]) });
  assert.match(summarizeChainActivity(empty), /no transactions/);

  const down = await verifyOnChainActivity({ ...base, fetchImpl: fetchThatThrows("boom") });
  assert.match(summarizeChainActivity(down), /unreachable, not verified/);
});
