import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const { nextRunningHash, GENESIS_RUNNING_HASH } = await import(
  pathToFileURL(path.resolve("dist/runningHash.js")).href
);
const { verifyRunningHashChain, validateHcsTopic, findSequenceGaps } = await import(
  pathToFileURL(path.resolve("dist/validation/hcsValidator.js")).href
);

const fixture = JSON.parse(readFileSync(new URL("./fixture-topic.json", import.meta.url), "utf8"));
const TOPIC = fixture.topicId;
const FIXTURE = fixture.messages;

const clone = () => JSON.parse(JSON.stringify(FIXTURE));

test("reproduces the real chain from genesis", () => {
  const result = verifyRunningHashChain(TOPIC, FIXTURE);
  assert.equal(result.ok, true);
  assert.equal(result.brokeAt, null);
});

test("first message chains from 48 zero bytes", () => {
  const m = FIXTURE[0];
  const computed = nextRunningHash({
    prevRunningHash: GENESIS_RUNNING_HASH,
    version: m.running_hash_version,
    payerAccountId: m.payer_account_id,
    topicId: TOPIC,
    consensusTimestamp: m.consensus_timestamp,
    sequenceNumber: m.sequence_number,
    messageBytes: Buffer.from(m.message, "base64"),
  });
  assert.equal(computed.toString("base64"), m.running_hash);
  assert.equal(computed.length, 48);
});

test("detects a single flipped bit, naming the sequence number", () => {
  const messages = clone();
  const bytes = Buffer.from(messages[1].message, "base64");
  bytes[0] = bytes[0] ^ 0x01;
  messages[1].message = bytes.toString("base64");

  const result = verifyRunningHashChain(TOPIC, messages);
  assert.equal(result.ok, false);
  assert.equal(result.brokeAt, 2);
  assert.equal(result.reason, "running hash mismatch");
});

test("detects a sequence gap left by a removed message", () => {
  const messages = clone();
  messages.splice(1, 1);   // remove the middle message
  const result = verifyRunningHashChain(TOPIC, messages);
  assert.equal(result.ok, false);
  assert.match(result.reason, /sequence gap: expected 2, got 3/);
});

test("detects reordering", () => {
  const messages = clone();
  [messages[1], messages[2]] = [messages[2], messages[1]];
  assert.equal(verifyRunningHashChain(TOPIC, messages).ok, false);
});

test("refuses an unsupported running_hash_version rather than guessing", () => {
  const messages = clone();
  messages[0].running_hash_version = 2;
  const result = verifyRunningHashChain(TOPIC, messages);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsupported running_hash_version 2/);
});

test("THE FOOTGUN: hashing the documented field list alone does NOT match", async () => {
  const crypto = await import("node:crypto");
  const sha384 = (b) => crypto.createHash("sha384").update(b).digest();
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); return b; };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(Number(v)); return b; };

  const m = FIXTURE[0];
  const [ps, pr, pn] = m.payer_account_id.split(".");
  const [ts, tr, tn] = TOPIC.split(".");
  const [secs, nanos] = m.consensus_timestamp.split(".");

  const naive = sha384(Buffer.concat([
    GENESIS_RUNNING_HASH, i64(m.running_hash_version),
    i64(ps), i64(pr), i64(pn), i64(ts), i64(tr), i64(tn),
    i64(secs), i32(nanos.padEnd(9, "0")), i64(m.sequence_number),
    sha384(Buffer.from(m.message, "base64")),
  ]));

  assert.notEqual(naive.toString("base64"), m.running_hash);
});

test("rejects a malformed topic id instead of calling the network", async () => {
  const result = await validateHcsTopic("not-a-topic", { topicIdEnv: "X" });
  assert.equal(result.status, "fail");
  assert.match(result.problems[0], /not a valid Hedera entity id/);
});

test("an invalid regex in expectMessagesMatching fails loudly at build time", async () => {
  await assert.rejects(
    () => validateHcsTopic("0.0.1", { topicIdEnv: "X", expectMessagesMatching: "/[/" }),
    /not a valid regex/,
  );
});

test("findSequenceGaps: a dense run has no gaps", () => {
  const r = findSequenceGaps(['{"seq":1}', '{"seq":2}', '{"seq":3}'], "seq");
  assert.deepEqual(r.missing, []);
  assert.equal(r.duplicated, false);
});

test("findSequenceGaps: THE POINT — a withheld record is caught", () => {
  const r = findSequenceGaps(['{"seq":1}', '{"seq":3}'], "seq");
  assert.deepEqual(r.missing, [2]);
});

test("findSequenceGaps: bounded to the range OBSERVED, never 1..max", () => {
  const r = findSequenceGaps(['{"seq":50}', '{"seq":51}'], "seq");
  assert.deepEqual(r.missing, []);
});

test("findSequenceGaps: issuers are checked SEPARATELY", () => {
  const r = findSequenceGaps(
    ['{"seq":1,"who":"a"}', '{"seq":1,"who":"b"}', '{"seq":2,"who":"a"}', '{"seq":2,"who":"b"}'],
    "seq",
    "who",
  );
  assert.deepEqual(r.missing, []);
  assert.equal(r.duplicated, false);
});

test("findSequenceGaps: a gap in ONE issuer is still caught", () => {
  const r = findSequenceGaps(
    ['{"seq":1,"who":"a"}', '{"seq":3,"who":"a"}', '{"seq":1,"who":"b"}'],
    "seq",
    "who",
  );
  assert.deepEqual(r.missing, [2]);
});

test("findSequenceGaps: a repeated value is renumbering, not suppression", () => {
  const r = findSequenceGaps(['{"seq":1}', '{"seq":1}', '{"seq":2}'], "seq");
  assert.equal(r.duplicated, true);
});

test("findSequenceGaps: numbers may arrive as decimal strings", () => {
  const r = findSequenceGaps(['{"seq":"1"}', '{"seq":"2"}'], "seq");
  assert.deepEqual(r.missing, []);
});

test("findSequenceGaps: unnumbered and malformed messages are counted, not failed", () => {
  const r = findSequenceGaps(['not json', '{"other":1}', '{"seq":1}', '{"seq":2}'], "seq");
  assert.deepEqual(r.missing, []);
  assert.equal(r.unparsed, 2);
});
