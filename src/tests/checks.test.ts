import assert from "node:assert/strict";
import test from "node:test";
import { type Check, baseline, locate, read, settle } from "../checks.js";
import { type Outcome, override } from "../evaluate.js";
import { describeFailure, fromCheck } from "../failure.js";

/**
 * The executor is tested against a local server standing in for the mirror
 * node, because the point of these checks is that the harness reads an
 * independent system — and a test that mocks the read away would be checking
 * nothing at all.
 */
async function serving(body: unknown, status = 200): Promise<{ base: string; stop: () => void }> {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

function claim(expect: Check["expect"], over: Partial<Check> = {}): Check {
  return {
    id: locate("chain", "accounts/0.0.2", "balance.balance", expect),
    source: "declared",
    kind: "chain",
    path: "accounts/0.0.2",
    field: "balance.balance",
    expect,
    ...over,
  };
}

test("a claim that holds, held", async () => {
  const mirror = await serving({ balance: { balance: 500 } });
  try {
    assert.equal((await settle({ mirrorNode: mirror.base, appUrl: mirror.base }, claim({ atLeast: 100 }))).state, "held");
  } finally {
    mirror.stop();
  }
});

test("a claim that does not hold, failed — with what was actually there", async () => {
  const mirror = await serving({ balance: { balance: 50 } });
  try {
    const result = await settle({ mirrorNode: mirror.base, appUrl: mirror.base }, claim({ atLeast: 100 }));
    assert.equal(result.state, "failed");
    assert.match(result.detail, /expected at least 100, found 50/);
  } finally {
    mirror.stop();
  }
});

/**
 * The rule that keeps the mechanical layer worth trusting over the judge: it
 * must never manufacture a failure out of its own bugs. A path that 404s, a
 * field that is not there, a value that is not a number — none of those are
 * the app being wrong.
 */
test("a claim that cannot be read errors, and erroring is not failing", async () => {
  const missing = await serving({ _status: "not found" }, 404);
  try {
    const result = await settle({ mirrorNode: missing.base, appUrl: missing.base }, claim({ atLeast: 1 }));
    assert.equal(result.state, "errored");
    assert.match(result.detail, /answered 404/);
  } finally {
    missing.stop();
  }

  const wrongShape = await serving({ balance: {} });
  try {
    assert.equal((await settle({ mirrorNode: wrongShape.base, appUrl: wrongShape.base }, claim({ atLeast: 1 }))).state, "errored");
  } finally {
    wrongShape.stop();
  }

  const notNumeric = await serving({ balance: { balance: "many" } });
  try {
    const result = await settle({ mirrorNode: notNumeric.base, appUrl: notNumeric.base }, claim({ atLeast: 1 }));
    assert.equal(result.state, "errored", "a non-numeric field is the check's mistake, not the app's");
  } finally {
    notNumeric.stop();
  }
});

/**
 * Why declaration precedes the action. "It rose by 250" is unverifiable unless
 * something wrote down what it was beforehand — and a check declared after the
 * fact cannot recover that moment.
 */
test("a delta is measured against the value when it was declared", async () => {
  const before = await serving({ balance: { balance: 1000 } });
  let declared: Check;
  try {
    declared = await baseline(before.base, claim({ increasedBy: 250 }));
    assert.equal(declared.baseline, 1000);
  } finally {
    before.stop();
  }

  const after = await serving({ balance: { balance: 1250 } });
  try {
    assert.equal((await settle({ mirrorNode: after.base, appUrl: after.base }, declared)).state, "held");
  } finally {
    after.stop();
  }

  const wrong = await serving({ balance: { balance: 1100 } });
  try {
    const result = await settle({ mirrorNode: wrong.base, appUrl: wrong.base }, declared);
    assert.equal(result.state, "failed");
    assert.match(result.detail, /a rise of 250, found 100/);
  } finally {
    wrong.stop();
  }
});

test("a delta declared with no baseline errors rather than guessing", async () => {
  const mirror = await serving({ balance: { balance: 10 } });
  try {
    const result = await settle({ mirrorNode: mirror.base, appUrl: mirror.base }, claim({ increasedBy: 5 }));
    assert.equal(result.state, "errored");
    assert.match(result.detail, /no baseline/);
  } finally {
    mirror.stop();
  }
});

test("text expectations read the value as text", async () => {
  const mirror = await serving({ account: "0.0.2", evm_address: "0xabc" });
  try {
    const at = (field: string, expect: Check["expect"]) =>
      settle({ mirrorNode: mirror.base, appUrl: mirror.base }, claim(expect, { field, id: locate("chain", "accounts/0.0.2", field, expect) }));
    assert.equal((await at("account", { equals: "0.0.2" })).state, "held");
    assert.equal((await at("account", { equals: "0.0.3" })).state, "failed");
    assert.equal((await at("evm_address", { matches: "^0x[0-9a-f]+$" })).state, "held");
    assert.equal((await at("evm_address", { contains: "abc" })).state, "held");
  } finally {
    mirror.stop();
  }
});

/** A measured failure is a failure like any other — same identity, same prose shape. */
test("a failed check becomes a failure the loop already understands", () => {
  const failure = fromCheck({
    check: claim({ atLeast: 100 }),
    state: "failed",
    detail: "expected at least 100, found 50",
  });
  assert.equal(failure.kind, "check");
  assert.equal(failure.id.length, 12, "hashed like every other failure identity");
  assert.equal(
    describeFailure(failure),
    "chain:accounts/0.0.2:balance.balance:atLeast=100: expected at least 100, found 50",
  );
});

test("two claims about one field are two checks", () => {
  const body = (contains: string) => locate("http", "/status", "body", { contains });
  assert.notEqual(
    body("Hedera Testnet"),
    body("40628061"),
    "one route, one field, two claims — collapsing them would give them one identity",
  );
  assert.match(locate("chain", "accounts/0.0.2", "balance.balance", { atLeast: 1 }), /^chain:accounts/);
  assert.match(locate("http", "/send", "status", { equals: 200 }), /^http:\/send:status/);
});

test("read reaches the mirror node's own path shape", async () => {
  const mirror = await serving({ blocks: [{ number: 42 }] });
  try {
    const found = await read(mirror.base, "/blocks?limit=1", "blocks");
    assert.ok("value" in found && Array.isArray(found.value));
  } finally {
    mirror.stop();
  }
});

/** The rule this whole mechanism exists to enforce. */
test("a failed check turns a pass into a fail, and never the reverse", () => {
  const passing: Outcome = { type: "verdict", verdict: { pass: true, failures: [] }, checks: [] };
  const failing: Outcome = {
    type: "verdict",
    verdict: { pass: false, failures: [{ what: "broken", where: "/x", evidence: ["a.png"] }] },
    checks: [],
  };
  const untrue = { check: claim({ atLeast: 100 }), state: "failed" as const, detail: "found 50" };
  const held = { check: claim({ atLeast: 1 }), state: "held" as const, detail: "found 50" };
  const errored = { check: claim({ atLeast: 1 }), state: "errored" as const, detail: "404" };

  assert.equal(passed(override(passing, [untrue])), false, "a failed check overrides a pass");
  assert.equal(passed(override(passing, [held])), true);
  assert.equal(passed(override(passing, [])), true);
  assert.equal(
    passed(override(passing, [errored])),
    true,
    "an unreadable check must never fail the app",
  );
  assert.equal(
    passed(override(failing, [held])),
    false,
    "a held check never rescues a verdict the judge failed",
  );
});

test("a check read out of the spec reports, and never overrides", () => {
  const passing: Outcome = { type: "verdict", verdict: { pass: true, failures: [] }, checks: [] };
  const read = { check: claim({ atLeast: 100 }, { source: "derived" }), state: "failed" as const, detail: "found 50" };
  const after = override(passing, [read]);
  assert.equal(passed(after), true);
  assert.equal(after.type === "verdict" && after.checks.length, 1, "but it is still reported");
});

test("a pattern that will not parse is unreadable, not a failure", async () => {
  const mirror = await serving({ balance: { balance: 500 } });
  try {
    // `(?i)` is ordinary elsewhere and meaningless to `new RegExp`; the deriver
    // wrote exactly this against a real spec.
    const result = await settle(
      { mirrorNode: mirror.base, appUrl: mirror.base },
      claim({ matches: "(?i)not.?found" }),
    );
    assert.equal(result.state, "errored");
  } finally {
    mirror.stop();
  }
});

test("no verdict is left alone — there is nothing to override", () => {
  const none: Outcome = { type: "no-verdict", reason: "stopped", why: "cut-off" };
  assert.deepEqual(override(none, []), none);
});

function passed(outcome: Outcome): boolean {
  return outcome.type === "verdict" && outcome.verdict.pass;
}

/**
 * The second kind. A route the spec says exists is one of the few things a
 * check derived from prose can settle — it needs no judgement and nothing the
 * run creates.
 */
test("an http check reads the app's own answer", async () => {
  const app = await serving({ ok: true });
  const where = { mirrorNode: app.base, appUrl: app.base };
  const route = (field: string, expect: Check["expect"]): Check => ({
    id: locate("http", "/status", field, expect),
    source: "declared",
    kind: "http",
    path: "/status",
    field,
    expect,
  });
  try {
    assert.equal((await settle(where, route("status", { equals: 200 }))).state, "held");
    assert.equal((await settle(where, route("status", { equals: 404 }))).state, "failed");
    assert.equal((await settle(where, route("body", { contains: '"ok"' }))).state, "held");
    assert.equal(
      (await settle(where, route("headers", { equals: "x" }))).state,
      "errored",
      "an http check reads status or body, and asking for anything else is the check's mistake",
    );
  } finally {
    app.stop();
  }
});

test("an app that is not answering errors rather than failing", async () => {
  const where = { mirrorNode: "http://127.0.0.1:1", appUrl: "http://127.0.0.1:1" };
  const check: Check = {
    id: locate("http", "/status", "status", { equals: 200 }),
    source: "declared",
    kind: "http",
    path: "/status",
    field: "status",
    expect: { equals: 200 },
  };
  assert.equal((await settle(where, check)).state, "errored");
});

test("what was found is quoted, not archived", async () => {
  const page = await serving(`<html>${"x".repeat(5000)}</html>`);
  try {
    const check: Check = {
      id: locate("http", "/", "body", { contains: "nope" }),
      source: "declared",
      kind: "http",
      path: "/",
      field: "body",
      expect: { contains: "nope" },
    };
    const result = await settle({ mirrorNode: page.base, appUrl: page.base }, check);
    assert.equal(result.state, "failed");
    assert.ok(result.detail.length < 200, `a page is not an explanation: ${result.detail.length} chars`);
    assert.match(result.detail, /…$/);
  } finally {
    page.stop();
  }
});
