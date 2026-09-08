import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { attachChainVerification, verifyChainTransactions } = await import(
  pathToFileURL(path.resolve("dist/validation/chainVerification.js")).href
);

const signer = {
  accountId: "0.0.1234",
  evmAddress: "0x1111111111111111111111111111111111111111",
  privateKeyHex: "0xsecret",
  network: "testnet",
};
const since = new Date("2026-09-08T12:34:56.000Z");

test("CHAIN proves required transaction types for this signer and attempt window", async () => {
  const requested = [];
  const result = await verifyChainTransactions(
    signer,
    {
      transactionTypes: ["CONSENSUSSUBMITMESSAGE", "TOKENCREATION"],
      timeoutMs: 100,
    },
    since,
    {
      maxPolls: 1,
      fetch: async input => {
        const url = new URL(String(input));
        requested.push(url);
        const type = url.searchParams.get("transactiontype");
        return Response.json({
          transactions: [
            {
              transaction_id: `${signer.accountId}-1234567890-000000001`,
              consensus_timestamp: "1788870896.123456789",
              entity_id: type === "TOKENCREATION" ? "0.0.5678" : "0.0.9012",
            },
          ],
        });
      },
    },
  );

  assert.equal(result.passed, true);
  assert.equal(result.proofs.length, 2);
  assert.deepEqual(
    requested.map(url => url.searchParams.get("account.id")),
    [signer.accountId, signer.accountId],
  );
  assert.deepEqual(
    requested.map(url => url.searchParams.get("timestamp")),
    ["gte:1788870896.000000000", "gte:1788870896.000000000"],
  );
  assert.ok(requested.every(url => url.searchParams.get("result") === "success"));
});

test("CHAIN reports an app finding when Mirror Node is reachable but no transaction exists", async () => {
  const result = await verifyChainTransactions(
    signer,
    { transactionTypes: ["CONSENSUSSUBMITMESSAGE"], timeoutMs: 100 },
    since,
    {
      maxPolls: 1,
      fetch: async () => Response.json({ transactions: [] }),
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.infrastructureFailure, undefined);
  assert.equal(result.findings[0].category, "chain");
  assert.match(result.findings[0].message, /No successful CONSENSUSSUBMITMESSAGE/);
});

test("CHAIN does not accept a transaction where the signer was involved but was not payer", async () => {
  const result = await verifyChainTransactions(
    signer,
    { transactionTypes: ["CRYPTOTRANSFER"], timeoutMs: 100 },
    since,
    {
      maxPolls: 1,
      fetch: async () =>
        Response.json({
          transactions: [
            {
              transaction_id: "0.0.9999-1788870896-000000001",
              consensus_timestamp: "1788870896.123456789",
            },
          ],
        }),
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.findings[0].category, "chain");
});

test("CHAIN classifies Mirror Node failure as infrastructure", async () => {
  const result = await verifyChainTransactions(
    signer,
    { transactionTypes: ["TOKENCREATION"], timeoutMs: 100 },
    since,
    {
      maxPolls: 1,
      fetch: async () => new Response("unavailable", { status: 503 }),
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.infrastructureFailure, true);
  assert.equal(result.findings[0].category, "chain-infra");
  assert.match(result.infrastructureFailureReason, /HTTP 503/);
});

test("CHAIN classifies a 200 with malformed payload as infrastructure", async () => {
  const result = await verifyChainTransactions(
    signer,
    { transactionTypes: ["TOKENCREATION"], timeoutMs: 100 },
    since,
    {
      maxPolls: 1,
      fetch: async () =>
        new Response("<html>gateway error</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    },
  );

  assert.equal(result.passed, false);
  assert.equal(result.infrastructureFailure, true);
  assert.equal(result.findings[0].category, "chain-infra");
});

test("CHAIN timestamps use millisecond precision", async () => {
  const requested = [];
  const precise = new Date("2026-09-08T12:34:56.789Z");
  await verifyChainTransactions(
    signer,
    { transactionTypes: ["CONSENSUSSUBMITMESSAGE"], timeoutMs: 100 },
    precise,
    {
      maxPolls: 1,
      fetch: async input => {
        requested.push(new URL(String(input)));
        return Response.json({ transactions: [] });
      },
    },
  );
  assert.equal(requested[0].searchParams.get("timestamp"), "gte:1788870896.789000000");
});

test("chain verification is attached to the evaluator result", () => {
  const evaluation = {
    passed: true,
    findings: [],
    durationMs: 25,
  };
  const chainVerification = {
    passed: false,
    transactionTypes: ["TOKENCREATION"],
    proofs: [],
    findings: [
      {
        id: "chain-transaction:tokencreation",
        category: "chain",
        message: "missing",
      },
    ],
    durationMs: 10,
  };

  const result = attachChainVerification(evaluation, chainVerification);
  assert.equal(result.passed, false);
  assert.equal(result.durationMs, 35);
  assert.equal(result.chainVerification, chainVerification);
  assert.equal(result.findings.length, 1);
});
