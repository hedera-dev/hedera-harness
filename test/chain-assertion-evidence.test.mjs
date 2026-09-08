import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  toMirrorTransactionId,
  extractTransactionId,
  fetchTransactionResult,
  fetchHbarBalanceTinybars,
  fetchTokenBalance,
} = await import(pathToFileURL(path.resolve("dist/validation/chainAssertionEvidence.js")).href);

test("toMirrorTransactionId converts SDK @ form to Mirror Node - form", () => {
  assert.equal(toMirrorTransactionId("0.0.1234@1699999999.123456789"), "0.0.1234-1699999999-123456789");
});

test("toMirrorTransactionId passes through an already-Mirror-Node-form id", () => {
  assert.equal(toMirrorTransactionId("0.0.1234-1699999999-123456789"), "0.0.1234-1699999999-123456789");
});

test("extractTransactionId finds a transaction id inside free-form script output", () => {
  const stdout = "deploying...\nsubmitted 0.0.10418936@1699999999.123456789\ndone";
  assert.equal(extractTransactionId(stdout), "0.0.10418936@1699999999.123456789");
});

test("extractTransactionId returns undefined when no id is present", () => {
  assert.equal(extractTransactionId("no transaction id here"), undefined);
});

/** Minimal controllable HTTP server standing in for Mirror Node in unit tests. */
async function withMockServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const FAST_POLL = { pollIntervalMs: 20, maxWaitMs: 150 };

test("fetchTransactionResult returns status:found on a clean 200", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          transactions: [{ transaction_id: "0.0.1-1-1", result: "SUCCESS", name: "CRYPTOTRANSFER", consensus_timestamp: "1.1" }],
        }),
      );
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: { result: "SUCCESS", consensusTimestamp: "1.1" } });
    },
  );
});

test("fetchTransactionResult retries through a 404 (propagation lag) and then finds it", async () => {
  let calls = 0;
  await withMockServer(
    (req, res) => {
      calls += 1;
      if (calls < 3) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          transactions: [{ transaction_id: "0.0.1-1-1", result: "CONTRACT_REVERT_EXECUTED", name: "CONTRACTCALL", consensus_timestamp: "1.1" }],
        }),
      );
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "found");
      assert.equal(result.value.result, "CONTRACT_REVERT_EXECUTED");
      assert.ok(calls >= 3, "expected at least 3 polls before the record appeared");
    },
  );
});

test("fetchTransactionResult reports not-found (never infra-error) when every poll 404s", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(404);
      res.end();
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "not-found" });
    },
  );
});

test("fetchTransactionResult reports infra-error (never not-found, never found) on a 500", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(500);
      res.end("server error");
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "infra-error");
    },
  );
});

test("fetchTransactionResult reports infra-error on malformed JSON, not a false found/not-found", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "infra-error");
    },
  );
});

test("fetchTransactionResult reports infra-error when the connection itself fails", async () => {
  // Nothing listens on this port — fetch() throws.
  const result = await fetchTransactionResult("0.0.1@1.1", {
    ...FAST_POLL,
    baseUrl: "http://127.0.0.1:1",
  });
  assert.equal(result.status, "infra-error");
});

test("fetchHbarBalanceTinybars decodes the balance field as a bigint", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ balance: { balance: 100_000_000_000, tokens: [] } }));
    },
    async baseUrl => {
      const result = await fetchHbarBalanceTinybars("0.0.1", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: 100_000_000_000n });
    },
  );
});

test("fetchTokenBalance returns 0n for an account with no association to that token", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ balance: { balance: 0, tokens: [{ token_id: "0.0.9999", balance: 42 }] } }));
    },
    async baseUrl => {
      const result = await fetchTokenBalance("0.0.1", "0.0.7777", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: 0n });
    },
  );
});

test("fetchTokenBalance finds the matching token entry", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ balance: { balance: 0, tokens: [{ token_id: "0.0.7777", balance: 42 }] } }));
    },
    async baseUrl => {
      const result = await fetchTokenBalance("0.0.1", "0.0.7777", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: 42n });
    },
  );
});

// --- Live testnet evidence (real Mirror Node) ---------------------------------------------

const hasOperatorEnv = Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY);

test(
  "a real HBAR transfer's transaction id resolves to result SUCCESS on the real Mirror Node",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const sdk = await import("@hiero-ledger/sdk");
    const operatorId = process.env.HEDERA_OPERATOR_ID;
    const operatorKey = sdk.PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY.replace(/^0x/i, ""));
    const client = sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

    try {
      const tx = await new sdk.TransferTransaction()
        .addHbarTransfer(operatorId, new sdk.Hbar(-0.001))
        .addHbarTransfer(operatorId, new sdk.Hbar(0.001))
        .execute(client);
      await tx.getReceipt(client);
      const transactionId = tx.transactionId.toString();

      const result = await fetchTransactionResult(transactionId, { maxWaitMs: 20_000, pollIntervalMs: 2_000 });
      assert.equal(result.status, "found");
      assert.equal(result.value.result, "SUCCESS");
    } finally {
      client.close();
    }
  },
);

test(
  "the operator's real HBAR balance is a positive bigint from the real Mirror Node",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const result = await fetchHbarBalanceTinybars(process.env.HEDERA_OPERATOR_ID, {
      maxWaitMs: 15_000,
      pollIntervalMs: 2_000,
    });
    assert.equal(result.status, "found");
    assert.ok(result.value > 0n);
  },
);
