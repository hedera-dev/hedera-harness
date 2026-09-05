import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  MIRROR_NODE_BASE_URLS,
  mirrorNodeBaseUrl,
  normalizeTransactionId,
  readMirrorNode,
  topicExists,
  waitForAccount,
  waitForMirrorNode,
  waitForTopicMessage,
  waitForTransaction,
} = await import(pathToFileURL(path.resolve("dist/validation/mirrorNode.js")).href);

const { detectEvalInfrastructureFailure } = await import(
  pathToFileURL(path.resolve("dist/evalInfra.js")).href
);

const { describeMirrorVisibility } = await import(
  pathToFileURL(path.resolve("dist/validation/chainSigner.js")).href
);

/** Replaces global fetch with a scripted sequence and records every URL hit. */
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const original = globalThis.fetch;

  globalThis.fetch = async url => {
    calls.push(String(url));
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => {
        if (next.body === undefined) throw new Error("no json body");
        return next.body;
      },
    };
  };

  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Fast polling so the timeout cases do not add seconds to the suite.
const fast = { initialDelayMs: 1, maxDelayMs: 2 };

test("the SDK transaction id form is converted, and the mirror form passes through", () => {
  // Measured against the mirror node on 5 September 2026: the @ form is
  // rejected with HTTP 400, and HashScan's route for it renders nothing.
  assert.equal(
    normalizeTransactionId("0.0.10362512@1788607966.707088459"),
    "0.0.10362512-1788607966-707088459",
  );
  assert.equal(
    normalizeTransactionId("0.0.10362512-1788607966-707088459"),
    "0.0.10362512-1788607966-707088459",
  );
  assert.equal(normalizeTransactionId("  0.0.7162784@1788602397.120605122  "), "0.0.7162784-1788602397-120605122");
});

test("an id that is neither form throws instead of building a URL that reads as absence", () => {
  assert.throws(() => normalizeTransactionId("0.0.10362512"), /Expected "0\.0\.x@sss\.nnn"/);
  assert.throws(() => normalizeTransactionId(""), /Not a Hedera transaction id/);
});

test("the base URL is testnet by default and overridable", () => {
  assert.equal(mirrorNodeBaseUrl(), MIRROR_NODE_BASE_URLS.testnet);
  assert.equal(mirrorNodeBaseUrl({ network: "previewnet" }), MIRROR_NODE_BASE_URLS.previewnet);
  assert.equal(mirrorNodeBaseUrl({ baseUrl: "http://localhost:5551/api/v1/" }), "http://localhost:5551/api/v1");
});

test("a 404 is a value, not a thrown error", async () => {
  const stub = stubFetch([{ status: 404, body: { _status: { messages: [{ detail: "Not found" }] } } }]);
  try {
    const result = await readMirrorNode("topics/0.0.999999999");
    assert.equal(result.status, 404);
    assert.equal(result.ok, false);
    assert.equal(result.error, undefined);
  } finally {
    stub.restore();
  }
});

test("a transport failure is reported rather than thrown", async () => {
  const stub = stubFetch([new Error("fetch failed")]);
  try {
    const result = await readMirrorNode("accounts/0.0.1234");
    assert.equal(result.status, 0);
    assert.match(result.error, /fetch failed/);
  } finally {
    stub.restore();
  }
});

test("a single read straight after consensus is a false negative, and the wait rides it out", async () => {
  // Verbatim shape of a real testnet run: the message read 83ms after the
  // receipt was 404, and the same URL answered 200 918ms later.
  const stub = stubFetch([
    { status: 404, body: {} },
    { status: 404, body: {} },
    { status: 200, body: { sequence_number: 1 } },
  ]);
  try {
    const single = await readMirrorNode("topics/0.0.10366475/messages/1");
    assert.equal(single.ok, false, "one read is not enough");

    const waited = await waitForMirrorNode("topics/0.0.10366475/messages/1", fast);
    assert.equal(waited.found, true);
    assert.equal(waited.attempts, 2, "kept reading until the mirror caught up");
    assert.deepEqual(waited.body, { sequence_number: 1 });
  } finally {
    stub.restore();
  }
});

test("polling stops at the deadline and says how long it waited", async () => {
  const stub = stubFetch([{ status: 404, body: {} }]);
  try {
    const result = await waitForMirrorNode("tokens/0.0.1/nfts/1", { ...fast, timeoutMs: 25 });
    assert.equal(result.found, false);
    assert.equal(result.status, 404);
    assert.ok(result.attempts >= 2, "retried before giving up");
    assert.ok(result.elapsedMs >= 0);
  } finally {
    stub.restore();
  }
});

test("a 4xx that is not 404 stops the poll, because waiting cannot fix a bad URL", async () => {
  const stub = stubFetch([
    { status: 400, body: { _status: { messages: [{ message: "Invalid Transaction id." }] } } },
  ]);
  try {
    const result = await waitForMirrorNode("transactions/0.0.7@1.2", { ...fast, timeoutMs: 5_000 });
    assert.equal(result.found, false);
    assert.equal(result.stoppedEarly, "client-error");
    assert.equal(result.attempts, 1, "must not burn the timeout on a malformed request");
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("a 5xx is transient and keeps the poll going", async () => {
  const stub = stubFetch([{ status: 504, body: {} }, { status: 200, body: { ok: true } }]);
  try {
    const result = await waitForMirrorNode("accounts/0.0.1234", fast);
    assert.equal(result.found, true);
    assert.equal(result.attempts, 2);
  } finally {
    stub.restore();
  }
});

test("a transaction is read in the mirror form even when the caller has the SDK form", async () => {
  const stub = stubFetch([{ status: 200, body: { transactions: [{ result: "SUCCESS" }] } }]);
  try {
    const result = await waitForTransaction("0.0.10362512@1788607966.707088459", fast);
    assert.equal(result.found, true);
    assert.ok(
      stub.calls[0].endsWith("/transactions/0.0.10362512-1788607966-707088459"),
      `converted before the read, got ${stub.calls[0]}`,
    );
  } finally {
    stub.restore();
  }
});

test("an account is read by id or by EVM address", async () => {
  const stub = stubFetch([{ status: 200, body: { account: "0.0.10366450" } }]);
  try {
    await waitForAccount("0x7c02879d6b95f923681f517b0487aa45af2b8fdf", fast);
    assert.ok(stub.calls[0].includes("/accounts/0x7c02879d6b95f923681f517b0487aa45af2b8fdf"));
  } finally {
    stub.restore();
  }
});

test("topic existence goes through /topics/{id}, which is the endpoint that 404s", async () => {
  const missing = stubFetch([{ status: 404, body: {} }]);
  try {
    assert.equal(await topicExists("0.0.999999999"), "no");
    assert.ok(missing.calls[0].endsWith("/topics/0.0.999999999"), "not the messages endpoint");
  } finally {
    missing.restore();
  }

  const present = stubFetch([{ status: 200, body: { topic_id: "0.0.10366475" } }]);
  try {
    assert.equal(await topicExists("0.0.10366475"), "yes");
  } finally {
    present.restore();
  }

  const down = stubFetch([new Error("ECONNREFUSED")]);
  try {
    assert.equal(await topicExists("0.0.10366475"), "unknown", "an outage is not an answer");
  } finally {
    down.restore();
  }
});

test("a wrong topic id fails in one read instead of looking like mirror lag", async () => {
  // /topics/{id}/messages answers 200 {"messages":[]} for a topic that does not
  // exist, so polling it can never distinguish the two.
  const stub = stubFetch([{ status: 404, body: {} }]);
  try {
    const result = await waitForTopicMessage("0.0.999999999", 1, { ...fast, timeoutMs: 5_000 });
    assert.equal(result.found, false);
    assert.equal(result.reason, "no-topic");
    assert.equal(stub.calls.length, 1, "did not poll the messages endpoint");
  } finally {
    stub.restore();
  }
});

test("a message on a live topic is polled past the empty list and returned unwrapped", async () => {
  const stub = stubFetch([
    { status: 200, body: { topic_id: "0.0.10366475" } },
    { status: 200, body: { messages: [], links: { next: null } } },
    { status: 200, body: { messages: [{ sequence_number: 1, message: "aGk=" }] } },
  ]);
  try {
    const result = await waitForTopicMessage("0.0.10366475", 1, fast);
    assert.equal(result.found, true);
    assert.deepEqual(result.body, { sequence_number: 1, message: "aGk=" });
    assert.ok(
      stub.calls[1].includes("sequencenumber=eq%3A1") || stub.calls[1].includes("sequencenumber=eq:1"),
      `read by the sequence filter, got ${stub.calls[1]}`,
    );
  } finally {
    stub.restore();
  }
});

test("a mirror node outage is classified as infrastructure, not as app defects", () => {
  // Verbatim from a testnet run against Hashio on 4 September 2026. The same
  // call succeeded unchanged a minute later.
  const outage = {
    passed: false,
    findings: [
      {
        id: "eval:e1",
        category: "eval",
        message:
          'critical [E1] (/): Submitting the form failed. Console: Error: could not coalesce error (error={ "code": -32020, "message": "Mirror node upstream failure: statusCode=504, message=timeout of 30000ms exceeded" }, code=UNKNOWN_ERROR)',
      },
      { id: "eval:e2", category: "eval", message: "critical [E2] (/): The receipt panel never appeared." },
      { id: "eval:e3", category: "eval", message: "major [E3] (/): No transaction id was shown." },
    ],
    verdict: { summary: "Three assertions failed against the running app.", issues: [] },
  };

  assert.ok(
    detectEvalInfrastructureFailure(outage),
    "a relay-side mirror outage must abort the run, not spend repair attempts",
  );
});

test("a consensus-level throttle is a retry, not a defect", () => {
  const throttled = {
    passed: false,
    findings: [
      { id: "eval:e1", category: "eval", message: "critical [E1] (/): submit failed: THROTTLED_AT_CONSENSUS" },
      { id: "eval:e2", category: "eval", message: "critical [E2] (/): no receipt" },
      { id: "eval:e3", category: "eval", message: "major [E3] (/): no id" },
    ],
    verdict: { summary: "", issues: [] },
  };

  assert.ok(detectEvalInfrastructureFailure(throttled));
});

test("an app that genuinely mishandles a transaction is still repaired", () => {
  const appBug = {
    passed: false,
    findings: [
      {
        id: "eval:e1",
        category: "eval",
        message: "critical [E1] (/): The app shows the transaction id as 0.0.7@1.2 and its HashScan link 404s.",
      },
      { id: "eval:e2", category: "eval", message: "major [E2] (/): The topic id input accepts an empty value." },
      { id: "eval:e3", category: "eval", message: "major [E3] (/): No loading state while the mirror node is read." },
    ],
    verdict: { summary: "Three assertions failed against the running app.", issues: [] },
  };

  assert.equal(
    detectEvalInfrastructureFailure(appBug),
    undefined,
    "mentioning the mirror node is not the same as the mirror node being down",
  );
});

test("the run log says how long the new signer took to reach the mirror node", () => {
  assert.equal(describeMirrorVisibility({ mirrorVisibleAfterMs: 1843 }), "mirror 1843ms");
  assert.equal(describeMirrorVisibility({ mirrorTimedOut: true }), "mirror not visible yet");
  assert.equal(describeMirrorVisibility({}), "", "a reused signer adds nothing to the line");
});
