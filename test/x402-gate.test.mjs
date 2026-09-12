import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const gate = await import(pathToFileURL(path.resolve("dist/validation/x402Gate.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { classifyRepairScope } = await import(
  pathToFileURL(path.resolve("dist/promptBuilder.js")).href
);
const sdk = await import("@hiero-ledger/sdk");

const NETWORK = "hedera:testnet";
const PAY_TO = "0.0.1234";
const FEE_PAYER = "0.0.999";
const AMOUNT = "100000"; // tinybars
const SETTLEMENT_TX = "0.0.999@1700000000.123456789";
const MIRROR = "http://mirror.test";

const encode = value => Buffer.from(JSON.stringify(value)).toString("base64");
const decode = header => JSON.parse(Buffer.from(header, "base64").toString("utf8"));

function paymentRequired(url, overrides = {}) {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: { url, description: "Quote", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        amount: AMOUNT,
        asset: "0.0.0",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { feePayer: FEE_PAYER },
        ...overrides,
      },
    ],
  };
}

/**
 * A resource server that behaves differently per path so one fixture covers
 * every gate verdict. `/api/quote` verifies the Hedera transaction for real.
 */
function startFixtureServer() {
  const seen = { paidTransactions: [] };

  /** What a real resource server delegates to the facilitator's /verify. */
  const verifyPayment = signature => {
    try {
      const payload = decode(String(signature));
      const bytes = Buffer.from(payload.payload.transaction, "base64");
      const transaction = sdk.Transaction.fromBytes(bytes);
      const credited = transaction.hbarTransfers.get(sdk.AccountId.fromString(PAY_TO));
      const verified =
        transaction instanceof sdk.TransferTransaction &&
        payload.accepted?.scheme === "exact" &&
        String(transaction.transactionId.accountId) === FEE_PAYER &&
        credited !== undefined &&
        credited.toTinybars().toString() === AMOUNT;
      if (verified) seen.paidTransactions.push(transaction);
      return verified;
    } catch {
      return false;
    }
  };

  const server = createServer((req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const route = new URL(url).pathname;
    const signature = req.headers["payment-signature"];
    const send402 = (body = paymentRequired(url)) => {
      res.writeHead(402, {
        "content-type": "application/json",
        "payment-required": encode(body),
      });
      res.end("{}");
    };

    switch (route) {
      case "/api/open":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"quote":"free for all"}');

      case "/api/legacy":
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ x402Version: 1, accepts: [{ scheme: "exact" }] }));

      case "/api/garbled":
        res.writeHead(402, { "payment-required": "%%%not-base64-json%%%" });
        return res.end();

      case "/api/wrong-shape":
        return send402(
          paymentRequired(url, {
            network: "eip155:296",
            amount: "0.001",
            extra: {},
          }),
        );

      case "/api/expensive":
        return send402(paymentRequired(url, { amount: "500000000" }));

      case "/api/forgeable":
        if (signature) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end('{"quote":"paid?"}');
        }
        return send402();

      case "/api/crash":
        if (signature) {
          res.writeHead(500);
          return res.end("TypeError: cannot read properties of undefined");
        }
        return send402();

      case "/api/no-receipt":
        if (!signature) return send402();
        if (!verifyPayment(signature)) return send402();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"quote":"paid"}');

      case "/facilitator/supported":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            kinds: [
              { x402Version: 2, scheme: "exact", network: "hedera:testnet" },
              { x402Version: 2, scheme: "exact", network: "hedera:mainnet" },
            ],
            extensions: [],
            signers: {},
          }),
        );

      case "/facilitator-evm/supported":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }] }),
        );

      case "/api/quote": {
        if (!signature) return send402();
        if (!verifyPayment(signature)) return send402();
        res.writeHead(200, {
          "content-type": "application/json",
          "payment-response": encode({
            success: true,
            transaction: SETTLEMENT_TX,
            network: NETWORK,
            payer: FEE_PAYER,
          }),
        });
        return res.end('{"quote":{"HBAR":"0.0842"}}');
      }

      default:
        res.writeHead(404);
        return res.end("not found");
    }
  });

  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

/** Real fetch for the fixture server, canned answers for the mirror node. */
function fetchWithMirror(mirrorResponses) {
  let calls = 0;
  return async (url, init) => {
    if (String(url).startsWith(MIRROR)) {
      const canned = mirrorResponses[Math.min(calls, mirrorResponses.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(canned.body), {
        status: canned.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, init);
  };
}

async function writeGateConfig(yaml) {
  const root = await makeTestTempDir("x402-gate-");
  const configPath = path.join(root, "x402.yaml");
  await writeFile(configPath, yaml);
  return configPath;
}

function findingIds(findings) {
  return findings.map(finding => finding.id).sort();
}

// ── Pure checks ──────────────────────────────────────────────────────────────

test("a spec-conformant Hedera exact requirement matches without findings", () => {
  const route = { name: "quote", path: "/api/quote", method: "GET", maxAmount: "1000000" };
  const evaluation = gate.evaluatePaymentRequired(
    paymentRequired("http://localhost/api/quote"),
    route,
    NETWORK,
  );
  assert.deepEqual(evaluation.findings, []);
  assert.equal(evaluation.x402Version, 2);
  assert.equal(evaluation.acceptsCount, 1);
  assert.equal(evaluation.matched?.payTo, PAY_TO);
  assert.equal(evaluation.matched?.extra?.feePayer, FEE_PAYER);
});

test("every Hedera exact-scheme MUST is reported by name", () => {
  const route = { name: "quote", path: "/api/quote", method: "GET" };
  const evaluation = gate.evaluatePaymentRequired(
    paymentRequired("http://localhost/api/quote", {
      network: "eip155:296",
      amount: "0.001",
      asset: "USDC",
      payTo: "not-an-account",
      maxTimeoutSeconds: -1,
      extra: {},
    }),
    route,
    NETWORK,
  );
  assert.deepEqual(findingIds(evaluation.findings), ["x402:route:quote:requirement"]);
  const details = evaluation.findings[0].details;
  for (const needle of [
    "network is \"eip155:296\"",
    "amount must be a string of whole smallest units",
    "asset must be \"0.0.0\"",
    "payTo must be a Hedera account id",
    "maxTimeoutSeconds must be a positive integer",
    "extra.feePayer must be the facilitator account id",
  ]) {
    assert.ok(details.includes(needle), `expected detail to mention ${needle}\n${details}`);
  }
  assert.equal(evaluation.matched, undefined);
});

test("route constraints bound price, receiver and asset", () => {
  const route = {
    name: "quote",
    path: "/api/quote",
    method: "GET",
    maxAmount: "1000",
    payTo: "0.0.4321",
    asset: "0.0.429274",
  };
  const evaluation = gate.evaluatePaymentRequired(
    paymentRequired("http://localhost/api/quote"),
    route,
    NETWORK,
  );
  const details = evaluation.findings[0].details;
  assert.ok(details.includes("exceeds the recipe ceiling of 1000"));
  assert.ok(details.includes("payTo is 0.0.1234; the recipe expects 0.0.4321"));
  assert.ok(details.includes("asset is 0.0.0; the recipe expects 0.0.429274"));
});

test("x402 v1 shape and a missing resource are called out separately", () => {
  const route = { name: "quote", path: "/api/quote", method: "GET" };
  const evaluation = gate.evaluatePaymentRequired(
    { x402Version: 1, accepts: [] },
    route,
    NETWORK,
  );
  assert.deepEqual(findingIds(evaluation.findings), [
    "x402:route:quote:accepts",
    "x402:route:quote:resource",
    "x402:route:quote:version",
  ]);
});

test("one valid option among malformed ones still matches, but the rest are reported", () => {
  const route = { name: "quote", path: "/api/quote", method: "GET" };
  const body = paymentRequired("http://localhost/api/quote");
  body.accepts.unshift({ scheme: "exact", network: "eip155:84532", amount: "10000" });
  const evaluation = gate.evaluatePaymentRequired(body, route, NETWORK);
  assert.equal(evaluation.matched?.network, NETWORK);
  assert.deepEqual(findingIds(evaluation.findings), ["x402:route:quote:requirement"]);
  assert.match(evaluation.findings[0].message, /1 accepted payment option\(s\) are malformed/);
});

test("mirror transaction ids are rewritten to the REST form", () => {
  assert.equal(
    gate.formatMirrorTransactionId("0.0.999@1700000000.123456789"),
    "0.0.999-1700000000-123456789",
  );
  assert.equal(gate.formatMirrorTransactionId("0.0.999@1700000000.5"), "0.0.999-1700000000-000000005");
  assert.equal(gate.formatMirrorTransactionId("0.0.999-1700000000-000000005"), "0.0.999-1700000000-000000005");
});

test("mirror grading needs SUCCESS and the exact credit to payTo", () => {
  const requirement = { scheme: "exact", network: NETWORK, amount: AMOUNT, asset: "0.0.0", payTo: PAY_TO };
  const success = {
    result: "SUCCESS",
    transfers: [
      { account: "0.0.5555", amount: -100000 },
      { account: PAY_TO, amount: 100000 },
      { account: "0.0.98", amount: 4200 },
    ],
  };
  assert.equal(gate.gradeMirrorTransactions([success], requirement).ok, true);
  assert.equal(gate.gradeMirrorTransactions([], requirement).terminal, false);

  const short = gate.gradeMirrorTransactions(
    [{ ...success, transfers: [{ account: PAY_TO, amount: 1 }] }],
    requirement,
  );
  assert.equal(short.ok, false);
  assert.match(short.detail, /credited 1 of tinybars of HBAR, expected exactly 100000/);

  const failed = gate.gradeMirrorTransactions([{ result: "INSUFFICIENT_PAYER_BALANCE" }], requirement);
  assert.equal(failed.terminal, true);
  assert.match(failed.detail, /INSUFFICIENT_PAYER_BALANCE/);

  const token = gate.gradeMirrorTransactions(
    [
      {
        result: "SUCCESS",
        transfers: [],
        token_transfers: [{ token_id: "0.0.429274", account: PAY_TO, amount: 1000 }],
      },
    ],
    { ...requirement, asset: "0.0.429274", amount: "1000" },
  );
  assert.equal(token.ok, true);
});

// ── Config ───────────────────────────────────────────────────────────────────

test("gate config rejects paying on mainnet, non-Hedera networks and decimal ceilings", async () => {
  await assert.rejects(
    gate.loadX402GateConfig(
      await writeGateConfig(`network: hedera:mainnet\npay: true\nroutes:\n  - name: q\n    path: /q\n`),
    ),
    /pay: true is not allowed on hedera:mainnet/,
  );
  await assert.rejects(
    gate.loadX402GateConfig(
      await writeGateConfig(`network: eip155:296\nroutes:\n  - name: q\n    path: /q\n`),
    ),
    /network must be a Hedera CAIP-2 id/,
  );
  await assert.rejects(
    gate.loadX402GateConfig(
      await writeGateConfig(`routes:\n  - name: q\n    path: /q\n    maxAmount: "0.5"\n`),
    ),
    /maxAmount must be a whole number/,
  );
  await assert.rejects(gate.loadX402GateConfig(await writeGateConfig(`routes: []\n`)), /at least one route/);

  const config = await gate.loadX402GateConfig(
    await writeGateConfig(`routes:\n  - name: q\n    path: /q\n    method: post\n    body:\n      symbol: HBAR\n`),
    { network: "hedera:testnet" },
  );
  assert.equal(config.network, "hedera:testnet");
  assert.equal(config.pay, false);
  assert.equal(config.routes[0].method, "POST");
  assert.deepEqual(config.routes[0].body, { symbol: "HBAR" });
});

test("validators.x402 requires validators.playwright", async () => {
  const root = await makeTestTempDir("x402-spec-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "x402.yaml"), "routes:\n  - name: q\n    path: /q\n");
  const specPath = path.join(root, ".harness", "spec.yaml");
  await writeFile(
    specPath,
    `schemaVersion: 3
name: paywall
baseline:
  commands:
    - name: install
      command: "true"
validators:
  x402: .harness/validators/x402.yaml
`,
  );
  await assert.rejects(loadTemplateSpec(specPath), /validators\.x402 requires validators\.playwright/);

  await writeFile(path.join(root, ".harness", "validators", "smoke.yaml"), "server:\n  command: true\n  url: http://127.0.0.1:1\nroutes:\n  - name: home\n    path: /\n");
  await writeFile(
    specPath,
    `schemaVersion: 3
name: paywall
baseline:
  commands:
    - name: install
      command: "true"
validators:
  playwright: .harness/validators/smoke.yaml
  x402: .harness/validators/x402.yaml
`,
  );
  const { spec } = await loadTemplateSpec(specPath);
  assert.match(spec.validators.x402Path, /x402\.yaml$/);
});

test("x402 findings are repaired in the runtime scope, like Playwright", () => {
  assert.equal(
    classifyRepairScope([{ id: "x402:route:quote:status", category: "x402", message: "open" }]),
    "runtime",
  );
  assert.equal(
    classifyRepairScope([
      { id: "x402:route:quote:status", category: "x402", message: "open" },
      { id: "required-file:x", category: "files", message: "missing" },
    ]),
    "broad",
  );
});

// ── Against a live resource server ───────────────────────────────────────────

test("the gate grades every kind of broken paywall with one finding each", async () => {
  const server = await startFixtureServer();
  try {
    const configPath = await writeGateConfig(`network: hedera:testnet
routes:
  - name: open
    path: /api/open
  - name: legacy
    path: /api/legacy
  - name: garbled
    path: /api/garbled
  - name: wrong-shape
    path: /api/wrong-shape
  - name: expensive
    path: /api/expensive
    maxAmount: "1000000"
  - name: forgeable
    path: /api/forgeable
  - name: crash
    path: /api/crash
  - name: quote
    path: /api/quote
`);
    const { result, findings } = await gate.runX402Gate(configPath, { url: server.url });

    assert.equal(result.passed, false);
    assert.deepEqual(findingIds(findings), [
      "x402:route:crash:tamper",
      "x402:route:expensive:requirement",
      "x402:route:forgeable:tamper",
      "x402:route:garbled:decode",
      "x402:route:legacy:header",
      "x402:route:open:status",
      "x402:route:wrong-shape:requirement",
    ]);

    const byId = Object.fromEntries(findings.map(finding => [finding.id, finding]));
    assert.match(byId["x402:route:open:status"].message, /served the resource without payment .*paywall is not enforced/);
    assert.match(byId["x402:route:legacy:header"].message, /x402 v1 JSON body but no PAYMENT-REQUIRED header/);
    assert.match(byId["x402:route:forgeable:tamper"].message, /forged PAYMENT-SIGNATURE .*payments are not verified/);
    assert.match(byId["x402:route:crash:tamper"].message, /crashed on a malformed PAYMENT-SIGNATURE \(HTTP 500\)/);
    assert.match(byId["x402:route:expensive:requirement"].details, /500000000 exceeds the recipe ceiling of 1000000/);

    const quote = result.routes.find(route => route.name === "quote");
    assert.equal(quote.statusCode, 402);
    assert.equal(quote.tamperStatusCode, 402);
    assert.equal(quote.x402Version, 2);
    assert.deepEqual(quote.requirement, {
      scheme: "exact",
      network: NETWORK,
      amount: AMOUNT,
      asset: "0.0.0",
      payTo: PAY_TO,
      feePayer: FEE_PAYER,
    });
    assert.equal(quote.paid, undefined);
    assert.equal(result.paid, false);
  } finally {
    await server.close();
  }
});

test("a correct paywall passes the unpaid probes with no findings", async () => {
  const server = await startFixtureServer();
  try {
    const configPath = await writeGateConfig(`routes:
  - name: quote
    path: /api/quote
    maxAmount: "1000000"
    payTo: ${PAY_TO}
    asset: "0.0.0"
`);
    const { result, findings } = await gate.runX402Gate(configPath, { url: server.url });
    assert.deepEqual(findings, []);
    assert.equal(result.passed, true);
    assert.equal(result.network, NETWORK);
  } finally {
    await server.close();
  }
});

test("the facilitator cross-check fails when it does not settle the route's network", async () => {
  const server = await startFixtureServer();
  try {
    const good = await gate.runX402Gate(
      await writeGateConfig(`facilitatorUrl: ${server.url}/facilitator\nroutes:\n  - name: quote\n    path: /api/quote\n`),
      { url: server.url },
    );
    assert.deepEqual(good.findings, []);

    const evmOnly = await gate.runX402Gate(
      await writeGateConfig(`facilitatorUrl: ${server.url}/facilitator-evm/\nroutes:\n  - name: quote\n    path: /api/quote\n`),
      { url: server.url },
    );
    assert.deepEqual(findingIds(evmOnly.findings), ["x402:facilitator:supported"]);
    assert.match(evmOnly.findings[0].details, /lists: exact@eip155:84532/);
  } finally {
    await server.close();
  }
});

test("pay: true without a CHAIN signer is a finding, not a silent skip", async () => {
  const server = await startFixtureServer();
  try {
    const { findings } = await gate.runX402Gate(
      await writeGateConfig(`pay: true\nroutes:\n  - name: quote\n    path: /api/quote\n`),
      { url: server.url },
    );
    assert.deepEqual(findingIds(findings), ["x402:gate:signer"]);
  } finally {
    await server.close();
  }
});

test("pay: true builds a spec-conformant partially signed transfer, pays, and verifies the settlement", async () => {
  const server = await startFixtureServer();
  const key = sdk.PrivateKey.generateECDSA();
  const signer = {
    accountId: "0.0.5555",
    privateKeyHex: `0x${key.toStringRaw()}`,
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    network: "testnet",
  };
  try {
    const configPath = await writeGateConfig(`pay: true
mirrorNodeUrl: ${MIRROR}
settlementTimeoutMs: 5000
routes:
  - name: quote
    path: /api/quote
  - name: no-receipt
    path: /api/no-receipt
`);
    const fetchImpl = fetchWithMirror([
      { status: 404, body: { _status: { messages: [{ message: "Not found" }] } } },
      {
        body: {
          transactions: [
            {
              result: "SUCCESS",
              transaction_id: "0.0.999-1700000000-123456789",
              transfers: [
                { account: "0.0.5555", amount: -100000 },
                { account: PAY_TO, amount: 100000 },
                { account: "0.0.999", amount: -5000 },
                { account: "0.0.98", amount: 5000 },
              ],
            },
          ],
        },
      },
    ]);
    const { result, findings } = await gate.runX402Gate(configPath, { url: server.url }, {
      chainSigner: signer,
      fetchImpl,
      sleepImpl: async () => undefined,
    });

    assert.deepEqual(findingIds(findings), ["x402:route:no-receipt:settlement"]);
    assert.match(findings[0].message, /accepted the payment but sent no PAYMENT-RESPONSE header/);

    const quote = result.routes.find(route => route.name === "quote");
    assert.equal(quote.paid.statusCode, 200);
    assert.equal(quote.paid.transactionId, SETTLEMENT_TX);
    assert.equal(quote.paid.settled, true);
    assert.equal(quote.paid.mirrorUrl, `${MIRROR}/api/v1/transactions/0.0.999-1700000000-123456789`);
    assert.equal(result.paid, true);

    // The fixture only answered 200 because the transaction was a real
    // TransferTransaction: payer → payTo for the exact amount, fee payer set.
    assert.equal(server.seen.paidTransactions.length, 2);
    const [transaction] = server.seen.paidTransactions;
    const debit = transaction.hbarTransfers.get(sdk.AccountId.fromString("0.0.5555"));
    assert.equal(debit.toTinybars().toString(), "-100000");
    assert.equal(String(transaction.transactionId.accountId), FEE_PAYER);
    assert.ok(transaction.isFrozen());
  } finally {
    await server.close();
  }
});

test("a settlement the mirror node never confirms fails the paid probe", async () => {
  const server = await startFixtureServer();
  const key = sdk.PrivateKey.generateECDSA();
  const signer = {
    accountId: "0.0.5555",
    privateKeyHex: key.toStringRaw(),
    evmAddress: `0x${key.publicKey.toEvmAddress()}`,
    network: "testnet",
  };
  try {
    const configPath = await writeGateConfig(`pay: true
mirrorNodeUrl: ${MIRROR}
settlementTimeoutMs: 10
routes:
  - name: quote
    path: /api/quote
`);
    const { findings } = await gate.runX402Gate(configPath, { url: server.url }, {
      chainSigner: signer,
      fetchImpl: fetchWithMirror([{ status: 404, body: {} }]),
      sleepImpl: async () => undefined,
    });
    assert.deepEqual(findingIds(findings), ["x402:route:quote:settlement"]);
    assert.match(findings[0].details, /has not indexed 0\.0\.999-1700000000-123456789 yet/);
  } finally {
    await server.close();
  }
});
