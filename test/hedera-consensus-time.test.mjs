import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { scanForConsensusDeadlineWaits, scanSource } = await import(
  pathToFileURL(path.resolve("dist/validation/hederaConsensusTime.js")).href
);

// The shape the generator reaches for once it discovers the relay has no
// evm_increaseTime: sleep on the local clock, then call the thing the deadline
// gates. The call reverts whenever consensus has not caught up.
const CLOCK_BUSY_WAIT = `
export async function settleExpiredPool(pools, poolId, deadline) {
  while (Date.now() / 1000 < deadline) await sleep(1_000);
  await sleep(1_000);
  await pools.settle(poolId);
}
`;

// The real defect this check is modeled on: the clock comparison is hidden one
// hop away in a helper, so the loop head never names Date.now() itself.
const ALIASED_CLOCK_WAIT = `
export async function awaitDeadline(report, pools, poolId, deadline) {
  const remaining = () => deadline - Math.floor(Date.now() / 1000);
  while (remaining() > 0) await new Promise((r) => setTimeout(r, 1_000));
  await new Promise((r) => setTimeout(r, 1_000));
  await pools.refund(poolId);
}
`;

// One computed sleep rather than a loop, same assumption.
const COMPUTED_SLEEP = `
export async function claim(escrow, id, expiresAt) {
  await sleep((expiresAt - Math.floor(Date.now() / 1000)) * 1_000);
  await escrow.claim(id);
}
`;

// The fix: a bounded poll that asks the contract and acts on the answer.
const BOUNDED_POLL = `
export async function awaitDeadline(report, pools, poolId, deadline) {
  const remaining = () => deadline - Math.floor(Date.now() / 1000);
  while (remaining() > 0) await new Promise((r) => setTimeout(r, 1_000));

  let state = await pools.statusOf(poolId);
  for (let attempt = 1; attempt < CONSENSUS_ATTEMPTS && state === "Open"; attempt++) {
    await new Promise((r) => setTimeout(r, CONSENSUS_INTERVAL_MS));
    state = await pools.statusOf(poolId);
  }
  return state;
}
`;

// A fixed pause for transaction propagation is not a deadline wait.
const FIXED_PROPAGATION_SLEEP = `
export async function deposit(pools, poolId, amount) {
  const tx = await pools.deposit(poolId, { value: amount });
  await tx.wait();
  await sleep(3_000);
  await pools.confirm(poolId);
}
`;

// A countdown rendered from the local clock is correct code: the UI should tick
// on the user's own clock, and nothing on-chain is gated on it.
const UI_COUNTDOWN = `
export function DeadlineBadge({ deadline }) {
  const [left, setLeft] = useState(deadline - Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setLeft(deadline - Math.floor(Date.now() / 1000)), 1_000);
    return () => clearInterval(id);
  }, [deadline]);
  return <span>{left}s left</span>;
}
`;

// A wait not derived from any deadline, followed by a call.
const UNRELATED_WAIT = `
export async function retryOnce(client, topicId) {
  await sleep(2_000);
  await client.submitMessage(topicId, "hello");
}
`;

test("flags a local-clock busy-wait followed by the deadline-gated call", () => {
  const findings = scanSource("e2e/settle.ts", CLOCK_BUSY_WAIT);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "hedera-consensus-time");
  assert.match(findings[0].id, /e2e\/settle\.ts:3$/);
  assert.match(findings[0].message, /local clock/);
});

test("flags a clock comparison hidden behind a helper binding", () => {
  const findings = scanSource("e2e/deadline.ts", ALIASED_CLOCK_WAIT);

  assert.equal(findings.length, 1);
  assert.match(findings[0].id, /e2e\/deadline\.ts:4$/);
  // The finding points at the call the wait gates, not just the wait.
  assert.match(findings[0].details, /e2e\/deadline\.ts:6/);
});

test("flags a single sleep whose duration is computed from a deadline", () => {
  const findings = scanSource("e2e/claim.ts", COMPUTED_SLEEP);

  assert.equal(findings.length, 1);
  assert.match(findings[0].id, /e2e\/claim\.ts:3$/);
});

test("does not flag a bounded poll that reads contract state", () => {
  assert.deepEqual(scanSource("e2e/poll.ts", BOUNDED_POLL), []);
});

test("does not flag a fixed propagation sleep", () => {
  assert.deepEqual(scanSource("e2e/deposit.ts", FIXED_PROPAGATION_SLEEP), []);
});

test("does not flag a UI countdown driven by the local clock", () => {
  assert.deepEqual(scanSource("app/DeadlineBadge.tsx", UI_COUNTDOWN), []);
});

test("does not flag a wait that is not derived from a deadline", () => {
  assert.deepEqual(scanSource("e2e/retry.ts", UNRELATED_WAIT), []);
});

test("does not flag a deadline wait with no call after it", () => {
  const source = `
export async function awaitDeadline(deadline) {
  while (Date.now() / 1000 < deadline) await sleep(1_000);
  console.log("the deadline passed");
}
`;
  assert.deepEqual(scanSource("e2e/wait-only.ts", source), []);
});

test("does not flag a commented-out example", () => {
  const source = `
export async function settle(pools, poolId, deadline) {
  // while (Date.now() / 1000 < deadline) await sleep(1_000);
  // await pools.settle(poolId);
  return pools.settleWhenNetworkAgrees(poolId);
}
`;
  assert.deepEqual(scanSource("e2e/documented.ts", source), []);
});

test("does not flag a commented-out example trailing a string literal", () => {
  // A quote earlier in the line must not stop the comment being stripped, or
  // the example inside it is read as the code that gates the call below.
  const source = `
export async function settle(pools, poolId, deadline) {
  const label = "expired"; // while (Date.now() / 1000 < deadline) await sleep(1_000);
  await pools.settle(poolId);
}
`;
  assert.deepEqual(scanSource("e2e/labelled.ts", source), []);
});

test("still flags a deadline wait in a file holding a URL literal", () => {
  // The other half of the same heuristic: stripping must not eat a `//` that
  // belongs to a string, or the line it sits on stops being scanned.
  const source = `
export async function settle(pools, poolId, deadline) {
  const docs = "https://docs.hedera.com/deadline";
  while (Date.now() / 1000 < deadline) await sleep(1_000);
  await pools.settle(poolId);
}
`;
  const findings = scanSource("e2e/urls.ts", source);

  assert.equal(findings.length, 1);
  assert.match(findings[0].id, /e2e\/urls\.ts:4$/);
});

test("does not flag a worked example inside a doc comment", () => {
  const source = `
/**
 * Do not do this:
 *
 *     while (Date.now() / 1000 < deadline) await sleep(1_000);
 *     await pools.settle(poolId);
 */
export async function settle(pools, poolId) {
  return pools.settleWhenNetworkAgrees(poolId);
}
`;
  assert.deepEqual(scanSource("e2e/documented.ts", source), []);
});

test("treats a minified bundle line as opaque rather than as evidence", () => {
  // One generated line holds a whole module, so the clock, a deadline-ish name
  // and an unrelated call collide on it without being the defect.
  const bundled = `var t=Date.now();function e(n){return n.deadline}${"var pad=1;".repeat(80)}await o.send(n);setTimeout(f,1e3);`;

  assert.deepEqual(scanSource("dist/app.bundle.js", bundled), []);
});

test("scans a workspace and skips node_modules and non-source files", async () => {
  const dir = await makeTestTempDir("hedera-consensus-time-");
  await mkdir(path.join(dir, "e2e"), { recursive: true });
  await mkdir(path.join(dir, "node_modules", "somepkg"), { recursive: true });
  await writeFile(path.join(dir, "e2e", "settle.ts"), CLOCK_BUSY_WAIT);
  await writeFile(path.join(dir, "node_modules", "somepkg", "settle.js"), CLOCK_BUSY_WAIT);
  await writeFile(path.join(dir, "NOTES.md"), CLOCK_BUSY_WAIT);

  const findings = await scanForConsensusDeadlineWaits(dir);

  assert.equal(findings.length, 1);
  assert.match(findings[0].id, /settle\.ts/);
});

test("a clean workspace produces no findings", async () => {
  const dir = await makeTestTempDir("hedera-consensus-time-clean-");
  await mkdir(path.join(dir, "e2e"), { recursive: true });
  await writeFile(path.join(dir, "e2e", "poll.ts"), BOUNDED_POLL);
  await writeFile(path.join(dir, "e2e", "deposit.ts"), FIXED_PROPAGATION_SLEEP);

  assert.deepEqual(await scanForConsensusDeadlineWaits(dir), []);
});
