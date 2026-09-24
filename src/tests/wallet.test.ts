import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { said } from "../messages.js";
import { funding, redact } from "../wallet.js";

async function serving(body: unknown, status = 200): Promise<{ base: string; stop: () => void }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/**
 * The account is checked by reading a public balance, which is the only thing
 * the harness ever needs the wallet for. A dry or mistyped account should cost
 * four seconds at DOCTOR rather than forty minutes and a verdict that blames
 * the app for having no funds.
 */
test("an account that can pay is fine, one that cannot is flagged", async () => {
  const funded = await serving({ balance: { balance: 50 * 100_000_000 } });
  try {
    const state = await funding(funded.base, "0.0.2");
    assert.equal(state.state, "ok");
    assert.equal(state.state === "ok" && state.hbar, 50);
  } finally {
    funded.stop();
  }

  const nearlyEmpty = await serving({ balance: { balance: 100_000_000 } });
  try {
    const state = await funding(nearlyEmpty.base, "0.0.2");
    assert.equal(state.state, "low", "1 ℏ cannot pay for much");
  } finally {
    nearlyEmpty.stop();
  }
});

test("an account that does not exist is missing, not empty", async () => {
  const absent = await serving({ _status: "not found" }, 404);
  try {
    const state = await funding(absent.base, "0.0.999999999");
    assert.equal(state.state, "missing");
    assert.match(state.state === "missing" ? state.reason : "", /404/);
  } finally {
    absent.stop();
  }
});

/**
 * The key reaches the evaluator, so it reaches anything the evaluator echoes —
 * and the transcript records every message either way. That makes it the one
 * artifact a live key must never survive in, which is why the scrub happens at
 * the write rather than being left to the agent's discretion.
 */
test("a key never survives into an artifact", () => {
  const key = "302e020100300506032b657004220420abcdef0123456789";
  const message = JSON.stringify({ type: "assistant", text: `setting it to ${key} now` });

  const written = redact(message, key);
  assert.doesNotMatch(written, /abcdef0123456789/);
  assert.match(written, /«redacted»/);
  assert.ok(written.includes("setting it to"), "only the key goes, not the context around it");
});

test("redaction removes every occurrence, not the first", () => {
  const key = "0xdeadbeefdeadbeefdeadbeef";
  const written = redact(`${key} … and again ${key}`, key);
  assert.equal(written.includes(key), false);
});

test("no wallet means nothing to redact, and no crash", () => {
  assert.equal(redact("nothing to hide", undefined), "nothing to hide");
  // A short value would match half the transcript; refusing is safer than
  // scrubbing everything that looks like it.
  assert.equal(redact("abc is everywhere", "abc"), "abc is everywhere");
});

/**
 * The transcript held everything an agent did and nothing it was asked. That
 * gap was not academic: confirming a corrected nudge had reached the model was
 * impossible from the artifacts, leaving only its behaviour to infer from — in
 * a tool whose whole claim is that you need not infer.
 */
test("a transcript records both halves, with the key removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-said-"));
  const transcript = join(dir, "evaluate.jsonl");
  const key = "302e020100300506032b657004220420feedfacefeedface";

  await said(transcript, "prompt", `sign with ${key} please`, key);
  await said(transcript, "nudge", "finish what you had not reached");

  const lines = (await readFile(transcript, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((entry: { type: string }) => entry.type),
    ["harness:prompt", "harness:nudge"],
    "marked so it cannot be mistaken for something the agent said",
  );
  assert.doesNotMatch(lines[0].text, /feedface/, "a brief carries a live key");
  assert.match(lines[0].text, /«redacted»/);
  assert.equal(lines[1].text, "finish what you had not reached");
});
