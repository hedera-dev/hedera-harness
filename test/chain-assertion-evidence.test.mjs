import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  toMirrorTransactionId,
  extractTransactionId,
  extractEvmTransactionHash,
  decodeStandardRevertReason,
  fetchTransactionResult,
  fetchContractCallResult,
  fetchHbarBalanceTinybars,
  fetchTokenBalance,
  fetchContractTokenBalance,
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

test("extractEvmTransactionHash finds an EVM tx hash inside free-form script output", () => {
  const stdout = "deploying...\nsubmitted 0x96063c55a83fe019edbebaf0482a27b117c2d22f7c663db48893411544002ff7\ndone";
  assert.equal(
    extractEvmTransactionHash(stdout),
    "0x96063c55a83fe019edbebaf0482a27b117c2d22f7c663db48893411544002ff7",
  );
});

test("extractEvmTransactionHash returns undefined for a native Hedera id (no false match)", () => {
  assert.equal(extractEvmTransactionHash("0.0.1234@1699999999.123456789"), undefined);
});

test("extractTransactionId returns undefined for an EVM hash (no false match the other way)", () => {
  assert.equal(
    extractTransactionId("0x96063c55a83fe019edbebaf0482a27b117c2d22f7c663db48893411544002ff7"),
    undefined,
  );
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

test("decodeStandardRevertReason decodes a real require(condition, \"message\") revert", () => {
  // ABI encoding of Error("KYC not granted"): selector + offset(32) + length(15) + padded bytes.
  const hex =
    "0x08c379a00000000000000000000000000000000000000000000000000000000000000020" +
    "000000000000000000000000000000000000000000000000000000000000000f" +
    "4b5943206e6f74206772616e7465640000000000000000000000000000000000";
  assert.equal(decodeStandardRevertReason(hex), "KYC not granted");
});

test("decodeStandardRevertReason returns undefined for a custom error (different selector)", () => {
  // A real custom-error revert from this project's own ATS fixture, e.g. selector 0x796c1f0d.
  assert.equal(
    decodeStandardRevertReason("0x796c1f0d000000000000000000000000ff1bdea3dca4c5889dde6ea61a3ce2d2ed84960a"),
    undefined,
  );
});

test("decodeStandardRevertReason returns undefined for malformed/short data", () => {
  assert.equal(decodeStandardRevertReason("0x08c379a0"), undefined);
  assert.equal(decodeStandardRevertReason("0x"), undefined);
});

test("fetchContractCallResult surfaces the decoded revertReason alongside the raw errorMessage", async () => {
  const errorHex =
    "0x08c379a00000000000000000000000000000000000000000000000000000000000000020" +
    "0000000000000000000000000000000000000000000000000000000000000003" +
    "4b59430000000000000000000000000000000000000000000000000000000000";
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ result: "CONTRACT_REVERT_EXECUTED", status: "0x0", timestamp: "1.1", error_message: errorHex }),
      );
    },
    async baseUrl => {
      const result = await fetchContractCallResult("0xabc", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "found");
      assert.equal(result.value.revertReason, "KYC");
      assert.equal(result.value.errorMessage, errorHex);
    },
  );
});

test("fetchContractCallResult omits revertReason for a custom error (undecodable without its ABI)", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          result: "CONTRACT_REVERT_EXECUTED",
          status: "0x0",
          timestamp: "1.1",
          error_message: "0x796c1f0d000000000000000000000000ff1bdea3dca4c5889dde6ea61a3ce2d2ed84960a",
        }),
      );
    },
    async baseUrl => {
      const result = await fetchContractCallResult("0xabc", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "found");
      assert.equal(result.value.revertReason, undefined);
      assert.ok(result.value.errorMessage);
    },
  );
});

test("a thrown fetch() retries through the full poll window instead of returning immediately", async () => {
  // No listener on this port -- fetch() throws on every attempt. Previously this returned
  // infra-error on the very first throw; it should now retry the same as a 404 would, only
  // giving up once maxWaitMs is spent -- provable by timing, since there's nothing to recover.
  const start = Date.now();
  const result = await fetchTransactionResult("0.0.1@1.1", {
    pollIntervalMs: 20,
    maxWaitMs: 100,
    baseUrl: "http://127.0.0.1:1",
  });
  assert.equal(result.status, "infra-error");
  assert.ok(
    Date.now() - start >= 90,
    "expected the retry loop to spend close to the full poll window, not return immediately",
  );
});

test("a thrown fetch() recovers if a later poll succeeds, same as a 404 recovering", async () => {
  let calls = 0;
  await withMockServer(
    (req, res) => {
      calls += 1;
      if (calls < 3) {
        // Simulate a connection-level failure (not an HTTP error response) -- destroying the
        // socket makes the client's fetch() throw, rather than resolve with a status code.
        res.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ transactions: [{ transaction_id: "0.0.1-1-1", result: "SUCCESS", consensus_timestamp: "1.1" }] }),
      );
    },
    async baseUrl => {
      const result = await fetchTransactionResult("0.0.1@1.1", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "found");
      assert.ok(calls >= 3, "expected at least 3 polls before recovering");
    },
  );
});

test("fetchContractCallResult returns status:found on a clean 200", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: "SUCCESS", status: "0x1", timestamp: "1.1", error_message: "0x" }));
    },
    async baseUrl => {
      const result = await fetchContractCallResult("0xabc", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: { result: "SUCCESS", consensusTimestamp: "1.1" } });
    },
  );
});

test("fetchContractCallResult surfaces a non-empty error_message as evidence", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          result: "CONTRACT_REVERT_EXECUTED",
          status: "0x0",
          timestamp: "1.1",
          error_message: "0x342c92db",
        }),
      );
    },
    async baseUrl => {
      const result = await fetchContractCallResult("0xabc", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "found");
      assert.equal(result.value.result, "CONTRACT_REVERT_EXECUTED");
      assert.equal(result.value.errorMessage, "0x342c92db");
    },
  );
});

test("fetchContractCallResult reports not-found when every poll 404s", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(404);
      res.end();
    },
    async baseUrl => {
      const result = await fetchContractCallResult("0xabc", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "not-found" });
    },
  );
});

// --- Live testnet evidence: real ATS (Asset Tokenization Studio) transactions -------------
//
// Read-only Mirror Node lookups against two permanent, already-recorded testnet transactions
// from building this fixture (see policy-probe/fixtures/ats-bond) — no operator credentials
// needed, since these are historical facts, not new transactions. Concrete proof that
// fetchContractCallResult correctly distinguishes a real EVM-relay success from a real revert.

test("a real ATS bond deployment's EVM tx hash resolves to result SUCCESS on the real Mirror Node", async () => {
  const result = await fetchContractCallResult(
    "0x96063c55a83fe019edbebaf0482a27b117c2d22f7c663db48893411544002ff7",
    { maxWaitMs: 15_000, pollIntervalMs: 2_000 },
  );
  assert.equal(result.status, "found");
  assert.equal(result.value.result, "SUCCESS");
});

test("a real ATS deploy attempt with an invalid ISIN resolves to CONTRACT_REVERT_EXECUTED with a decoded-able error_message", async () => {
  const result = await fetchContractCallResult(
    "0xfecdd182fec04ef27e951e8d033b4f0bfef76ff99fd3088ec6dfb4fd2584c22d",
    { maxWaitMs: 15_000, pollIntervalMs: 2_000 },
  );
  assert.equal(result.status, "found");
  assert.equal(result.value.result, "CONTRACT_REVERT_EXECUTED");
  assert.ok(result.value.errorMessage?.startsWith("0x"));
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

test("fetchTokenBalance retries (never finalizes on the first, still-unindexed poll) when a real non-zero balance only appears on a later response", async () => {
  // Regression test for a real bug: a brand-new token association can be absent from
  // `balance.tokens[]` for a few polls even though the account endpoint itself already answers
  // 200 (confirmed live against real testnet -- a fresh TokenCreateTransaction's treasury
  // balance took a few seconds to appear). The original implementation read the missing entry
  // as a confirmed `0n` on the very first poll, with no retry at all. This mock reproduces that
  // exact shape without depending on real testnet or real propagation timing: the entry is
  // absent on the first two polls, then present with a genuine non-zero balance.
  let call = 0;
  await withMockServer(
    (req, res) => {
      call += 1;
      const tokens = call < 3 ? [] : [{ token_id: "0.0.7777", balance: 12345 }];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ balance: { balance: 0, tokens } }));
    },
    async baseUrl => {
      const result = await fetchTokenBalance("0.0.1", "0.0.7777", { ...FAST_POLL, baseUrl });
      assert.deepEqual(result, { status: "found", value: 12345n });
      assert.ok(call >= 3, "must have retried past the polls where the entry was still missing");
    },
  );
});

test("fetchContractTokenBalance POSTs a standard ERC20 balanceOf(holder) call and decodes the result", async () => {
  let receivedBody;
  await withMockServer(
    (req, res) => {
      let raw = "";
      req.on("data", chunk => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: "0x0000000000000000000000000000000000000000000000000000000000000064" }));
      });
    },
    async baseUrl => {
      const result = await fetchContractTokenBalance(
        "0x19CD7866076758E3AF6C79aD7Ce725331A5606B8",
        "0xff1bdea3dca4c5889dde6ea61a3ce2d2ed84960a",
        { ...FAST_POLL, baseUrl },
      );
      assert.deepEqual(result, { status: "found", value: 100n });
      assert.equal(receivedBody.to, "0x19CD7866076758E3AF6C79aD7Ce725331A5606B8");
      assert.equal(
        receivedBody.data,
        "0x70a08231000000000000000000000000ff1bdea3dca4c5889dde6ea61a3ce2d2ed84960a",
      );
    },
  );
});

test("fetchContractTokenBalance reports infra-error, not a false zero balance, on a non-200", async () => {
  await withMockServer(
    (req, res) => {
      res.writeHead(500);
      res.end();
    },
    async baseUrl => {
      const result = await fetchContractTokenBalance("0xabc", "0xdef", { ...FAST_POLL, baseUrl });
      assert.equal(result.status, "infra-error");
    },
  );
});

// --- Live: a real ATS bond's real ERC20-style balance, confirmed absent from HTS entirely ---

test(
  "a real ATS bond holder has ZERO Mirror Node token associations (proving fetchTokenBalance can't see this balance at all)",
  async () => {
    const result = await fetchTokenBalance("0.0.10432567", "0.0.999999", { maxWaitMs: 15_000, pollIntervalMs: 2_000 });
    // No association at all -- reads as 0n, indistinguishable from "holds 0", which is exactly
    // the gap fetchContractTokenBalance exists to close for this class of token.
    assert.deepEqual(result, { status: "found", value: 0n });
  },
);

test(
  "fetchContractTokenBalance reads a real, non-zero ATS bond balance via the real Mirror Node contract-call simulation",
  async () => {
    const result = await fetchContractTokenBalance(
      "0x19CD7866076758E3AF6C79aD7Ce725331A5606B8", // the fixed bond, EVIDENCE.md
      "0x3a53dc3ed8df865a4d4e592c01a66efbcd37973b", // Alice, who genuinely holds a balance
      { maxWaitMs: 15_000, pollIntervalMs: 2_000 },
    );
    assert.equal(result.status, "found");
    assert.ok(result.value > 0n, "expected Alice's real, on-chain ATS bond balance to be positive");
  },
);

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

test(
  "fetchTokenBalance reads a real native HTS token's real minted supply — the primitive this whole function exists for, not yet exercised against a real HTS token anywhere else in this suite (only against HBAR and an EVM contract, which is NOT an HTS token)",
  { skip: !hasOperatorEnv && "HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY not set" },
  async () => {
    const sdk = await import("@hiero-ledger/sdk");
    const operatorId = process.env.HEDERA_OPERATOR_ID;
    const operatorKey = sdk.PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY.replace(/^0x/i, ""));
    const client = sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

    try {
      const receipt = await (
        await new sdk.TokenCreateTransaction()
          .setTokenName("PolicyProbe Test Token")
          .setTokenSymbol("PPTEST")
          .setTreasuryAccountId(operatorId)
          .setInitialSupply(12345)
          .setDecimals(0)
          .execute(client)
      ).getReceipt(client);
      const tokenId = receipt.tokenId.toString();

      // The treasury account automatically holds the full initial supply -- no association or
      // transfer step needed to prove the read path, which is all this test is for.
      const result = await fetchTokenBalance(operatorId, tokenId, { maxWaitMs: 20_000, pollIntervalMs: 2_000 });
      assert.equal(result.status, "found");
      assert.equal(result.value, 12345n);
    } finally {
      client.close();
    }
  },
);
