import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { parseScheduleIds, scheduleIdFromEvmAddress, verifyScheduleExecution, verifyScheduledTransactions } = await import(
  pathToFileURL(path.resolve("dist/validation/scheduleExecution.js")).href
);

// Real testnet responses captured from https://testnet.mirrornode.hedera.com on
// 2026-09-11. 0.0.10457460 executed and its scheduled call succeeded; 0.0.10457462
// (scheduled by that call) executed and reverted; 0.0.10456917 executed and ran out
// of gas. All three look the same on /schedules/{id}: executed_timestamp is set.
const SUCCESS = { schedule: "0.0.10457460", executed: "1789035662.019503208" };
const REVERTED = { schedule: "0.0.10457462", executed: "1789121682.025689368" };
const OUT_OF_GAS = { schedule: "0.0.10456917", executed: "1789035282.045161279" };
const CHILD_ID = "0.0.7314364-1789035654-697746300";

async function fixture(name) {
  const file = new URL(`./fixtures/mirror-node/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(file, "utf8"));
}

async function routesFor({ schedule, executed }) {
  return {
    [`/api/v1/schedules/${schedule}`]: [await fixture(`schedule-${schedule}`)],
    [`/api/v1/transactions?timestamp=${executed}`]: [await fixture(`transactions-at-${executed}`)],
  };
}

/**
 * Offline mirror node. `routes` maps path+query to a queue of answers: a number is
 * an HTTP status with an empty body, an Error is a transport failure, anything else
 * is a 200 JSON body. The last answer in a queue repeats.
 */
function stubMirrorNode(routes) {
  const requests = [];
  const fetch = async input => {
    const url = new URL(String(input));
    const key = `${url.pathname}${url.search}`;
    requests.push(key);
    const queue = routes[key];
    assert.ok(queue, `unexpected mirror node request ${key}`);
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("{}", { status: answer });
    return Response.json(answer);
  };
  return { fetch, requests };
}

const quick = { pollIntervalMs: 0, timeoutMs: 5_000 };
const impatient = { pollIntervalMs: 0, timeoutMs: 40 };

test("parseScheduleIds reads HARNESS_SCHEDULE_ID lines and nothing else", () => {
  const stdout = [
    "BondLifecycle deployed to 0.0.10457405",
    "  HARNESS_SCHEDULE_ID=0.0.10457460", // indented, as a forge console.log prints
    "created schedule 0.0.999 for coupon 3", // prose with an id is not a hand-off
    "HARNESS_SCHEDULE_ID=0.0.10457462 ",
    "HARNESS_SCHEDULE_ID=0.0.10457460", // repeated
    "HARNESS_SCHEDULE_ID=0x00000000000000000000000000000000009f9176", // long-zero address of 0.0.10457462, already listed
  ].join("\n");
  assert.deepEqual(parseScheduleIds(stdout), ["0.0.10457460", "0.0.10457462"]);
  assert.deepEqual(parseScheduleIds(""), []);
});

test("a schedule whose scheduled transaction succeeded passes, even once deleted", async () => {
  const mirror = stubMirrorNode(await routesFor(SUCCESS));
  const verdict = await verifyScheduleExecution(SUCCESS.schedule, { fetch: mirror.fetch, ...quick });

  assert.deepEqual(verdict, {
    ok: true,
    scheduleId: SUCCESS.schedule,
    executedTimestamp: SUCCESS.executed,
    transactionId: CHILD_ID,
  });
  assert.deepEqual(mirror.requests, [
    `/api/v1/schedules/${SUCCESS.schedule}`,
    `/api/v1/transactions?timestamp=${SUCCESS.executed}`,
  ]);

  // The scheduled call deleted its own schedule after running and created the
  // next one, so `deleted: true` must not be read as "never executed".
  const schedule = await fixture(`schedule-${SUCCESS.schedule}`);
  assert.equal(schedule.deleted, true);
  assert.equal(schedule.executed_timestamp, SUCCESS.executed);
});

test("a schedule that executed and reverted fails with the mirror node result", async () => {
  for (const [target, expected] of [
    [REVERTED, "CONTRACT_REVERT_EXECUTED"],
    [OUT_OF_GAS, "CONTRACT_REVERT_EXECUTED"],
  ]) {
    const mirror = stubMirrorNode(await routesFor(target));
    const verdict = await verifyScheduleExecution(target.schedule, { fetch: mirror.fetch, ...quick });

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, "failed");
    assert.equal(verdict.result, expected);
    assert.match(verdict.detail, new RegExp(`executed at ${target.executed.replace(".", "\\.")}`));

    // executed_timestamp alone would have called this a pass.
    const schedule = await fixture(`schedule-${target.schedule}`);
    assert.equal(schedule.executed_timestamp, target.executed);
  }
});

test("waits out mirror lag on both reads", async () => {
  const routes = await routesFor(SUCCESS);
  const schedulePath = `/api/v1/schedules/${SUCCESS.schedule}`;
  const childPath = `/api/v1/transactions?timestamp=${SUCCESS.executed}`;
  routes[schedulePath] = [404, 404, ...routes[schedulePath]];
  routes[childPath] = [{ transactions: [] }, ...routes[childPath]];
  const mirror = stubMirrorNode(routes);

  const verdict = await verifyScheduleExecution(SUCCESS.schedule, { fetch: mirror.fetch, ...quick });

  assert.equal(verdict.ok, true);
  assert.deepEqual(mirror.requests, [
    schedulePath,
    schedulePath,
    schedulePath,
    childPath,
    childPath,
  ]);
});

test("gives up when executed_timestamp stays null and names the expiry", async () => {
  const schedule = { ...(await fixture(`schedule-${REVERTED.schedule}`)), executed_timestamp: null };
  const mirror = stubMirrorNode({ [`/api/v1/schedules/${REVERTED.schedule}`]: [schedule] });

  const verdict = await verifyScheduleExecution(REVERTED.schedule, { fetch: mirror.fetch, ...impatient });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-executed");
  assert.match(verdict.detail, /expiration_time 1789121682\.000000000/);
  assert.match(verdict.detail, /after 0\.04s/);
  assert.ok(mirror.requests.length > 1, "should have polled");
});

test("a schedule that never appears times out as not-found", async () => {
  const mirror = stubMirrorNode({ "/api/v1/schedules/0.0.1": [404] });
  const verdict = await verifyScheduleExecution("0.0.1", { fetch: mirror.fetch, ...impatient });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-found");
});

test("a schedule deleted before executing fails at once", async () => {
  const schedule = {
    ...(await fixture(`schedule-${SUCCESS.schedule}`)),
    executed_timestamp: null,
    deleted: true,
  };
  const mirror = stubMirrorNode({ [`/api/v1/schedules/${SUCCESS.schedule}`]: [schedule] });

  const verdict = await verifyScheduleExecution(SUCCESS.schedule, { fetch: mirror.fetch, ...quick });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "deleted");
  assert.equal(mirror.requests.length, 1, "waiting cannot undelete a schedule");
});

test("retries 5xx and transport failures, stops on other 4xx", async () => {
  const routes = await routesFor(SUCCESS);
  const schedulePath = `/api/v1/schedules/${SUCCESS.schedule}`;
  routes[schedulePath] = [503, new Error("socket hang up"), 429, ...routes[schedulePath]];
  const flaky = stubMirrorNode(routes);
  const verdict = await verifyScheduleExecution(SUCCESS.schedule, { fetch: flaky.fetch, ...quick });
  assert.equal(verdict.ok, true);
  assert.equal(flaky.requests.length, 5);

  const broken = stubMirrorNode({ [schedulePath]: [400] });
  const rejected = await verifyScheduleExecution(SUCCESS.schedule, { fetch: broken.fetch, ...quick });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "mirror-node");
  assert.match(rejected.detail, /HTTP 400/);
  assert.equal(broken.requests.length, 1, "a 400 is not fixed by waiting");

  const down = stubMirrorNode({ [schedulePath]: [503] });
  const outage = await verifyScheduleExecution(SUCCESS.schedule, { fetch: down.fetch, ...impatient });
  assert.equal(outage.ok, false);
  assert.equal(outage.reason, "mirror-node");
  assert.match(outage.detail, /HTTP 503 after 0\.04s/);
});

test("verifyScheduledTransactions reports one commands finding per failed schedule", async () => {
  const mirror = stubMirrorNode({ ...(await routesFor(SUCCESS)), ...(await routesFor(REVERTED)) });

  const findings = await verifyScheduledTransactions([SUCCESS.schedule, REVERTED.schedule], {
    fetch: mirror.fetch,
    ...quick,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, `chain-schedule:${REVERTED.schedule}`);
  assert.equal(findings[0].category, "commands");
  assert.match(findings[0].message, /CONTRACT_REVERT_EXECUTED/);
  assert.match(findings[0].details, new RegExp(CHILD_ID));

  assert.deepEqual(
    await verifyScheduledTransactions([], { fetch: mirror.fetch, ...quick }),
    [],
  );
});

test("parseScheduleIds converts a HIP-1215 long-zero address to its entity id and skips alias addresses", () => {
  const stdout = [
    "  HARNESS_SCHEDULE_ID=0x00000000000000000000000000000000009f9176", // what scheduleCall returned for 0.0.10457462
    `HARNESS_SCHEDULE_ID=0x${"A031B5".padStart(40, "0")}`, // 0.0.10498485, upper-case hex`
    "HARNESS_SCHEDULE_ID=0x4d5d17D3b7B7a8b6d5d0dD2c1aB2c3D4e5F60718", // an alias address names no entity
  ].join("\n");
  assert.deepEqual(parseScheduleIds(stdout), ["0.0.10457462", "0.0.10498485"]);
  assert.equal(scheduleIdFromEvmAddress("0x00000000000000000000000000000000009f9176"), "0.0.10457462");
  assert.equal(scheduleIdFromEvmAddress("0x4d5d17D3b7B7a8b6d5d0dD2c1aB2c3D4e5F60718"), undefined);
  assert.equal(scheduleIdFromEvmAddress("0.0.10457462"), undefined);
});

test("a schedule that waits for an expiry beyond the budget fails at once, naming the expiry", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const mirror = stubMirrorNode({
    "/api/v1/schedules/0.0.10498485": [
      { deleted: false, executed_timestamp: null, expiration_time: `${expiresAt}.000000000`, wait_for_expiry: true },
    ],
  });
  const verdict = await verifyScheduleExecution("0.0.10498485", { fetch: mirror.fetch, ...quick });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-executed");
  assert.match(verdict.detail, /beyond the 5s wait budget/);
  assert.match(verdict.detail, /HARNESS_SCHEDULE_TIMEOUT_S/);
  assert.ok(verdict.detail.includes(`${expiresAt}.000000000`), verdict.detail);
  assert.equal(mirror.requests.length, 1, "no polling once the expiry rules the budget out");
});

test("a signature-gated schedule is waited for even when its expiry is far off", async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 1800;
  const mirror = stubMirrorNode({
    "/api/v1/schedules/0.0.777": [
      { deleted: false, executed_timestamp: null, expiration_time: `${expiresAt}.000000000`, wait_for_expiry: false },
    ],
  });
  const verdict = await verifyScheduleExecution("0.0.777", { fetch: mirror.fetch, ...impatient });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "not-executed");
  assert.match(verdict.detail, /executed_timestamp is still null .* after 0\.04s/);
  assert.ok(mirror.requests.length > 1, "kept polling until the budget ran out");
});
