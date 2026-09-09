import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { scanForHederaScheduleExecutedRisks } = await import(
  pathToFileURL(path.resolve("dist/validation/hederaScheduleExecuted.js")).href
);

// Mirrors the real gotcha the hedera-schedule-service skill (native-services-js
// plugin, hedera-dev/hedera-skills) documents and confirmed live: signing a
// ScheduleCreateTransaction to full completion still leaves `.executed === true`
// reading false, because ScheduleInfo.executed is a Timestamp | null, never a
// literal boolean.
const WRONG_EXECUTED_CHECK = `
import { ScheduleInfoQuery, Client } from "@hiero-ledger/sdk";

export async function checkStatus(client, scheduleId) {
  const info = await new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client);
  if (info.executed === true) {
    return "done";
  }
  return "pending";
}
`;

const CORRECT_EXECUTED_CHECK = `
import { ScheduleInfoQuery, Client } from "@hiero-ledger/sdk";

export async function checkStatus(client, scheduleId) {
  const info = await new ScheduleInfoQuery().setScheduleId(scheduleId).execute(client);
  if (info.executed !== null) {
    return info.executed.toDate().toISOString();
  }
  return "pending";
}
`;

const UNRELATED_EXECUTED_FIELD = `
export function summarizeWorkflow(job) {
  // A plain workflow-tracking object with its own real boolean \`executed\`
  // field — no Hedera SDK anywhere near this file.
  if (job.executed === true) {
    return "done";
  }
  return "pending";
}
`;

test("flags .executed === true in a file that imports the Hedera SDK", async () => {
  const dir = await makeTestTempDir("schedule-executed-bad-");
  await mkdir(path.join(dir, "app"), { recursive: true });
  await writeFile(path.join(dir, "app", "schedule.ts"), WRONG_EXECUTED_CHECK);

  const findings = await scanForHederaScheduleExecutedRisks(dir);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "hedera-schedule-executed");
  assert.match(findings[0].id, /app\/schedule\.ts/);
});

test("does not flag the correct non-null check", async () => {
  const dir = await makeTestTempDir("schedule-executed-good-");
  await mkdir(path.join(dir, "app"), { recursive: true });
  await writeFile(path.join(dir, "app", "schedule.ts"), CORRECT_EXECUTED_CHECK);

  const findings = await scanForHederaScheduleExecutedRisks(dir);

  assert.deepEqual(findings, []);
});

test("does not flag an unrelated executed field in a file with no Hedera SDK import", async () => {
  const dir = await makeTestTempDir("schedule-executed-unrelated-");
  await mkdir(path.join(dir, "app"), { recursive: true });
  await writeFile(path.join(dir, "app", "workflow.ts"), UNRELATED_EXECUTED_FIELD);

  const findings = await scanForHederaScheduleExecutedRisks(dir);

  assert.deepEqual(findings, []);
});

test("also flags the pattern via @hashgraph/sdk (the predecessor package name)", async () => {
  const dir = await makeTestTempDir("schedule-executed-hashgraph-");
  await mkdir(path.join(dir, "app"), { recursive: true });
  await writeFile(
    path.join(dir, "app", "schedule.ts"),
    WRONG_EXECUTED_CHECK.replace("@hiero-ledger/sdk", "@hashgraph/sdk"),
  );

  const findings = await scanForHederaScheduleExecutedRisks(dir);

  assert.equal(findings.length, 1);
});

test("ignores non-script files and skipped directories", async () => {
  const dir = await makeTestTempDir("schedule-executed-skip-");
  await mkdir(path.join(dir, "node_modules", "somepkg"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "somepkg", "schedule.ts"), WRONG_EXECUTED_CHECK);
  await writeFile(path.join(dir, "notes.md"), WRONG_EXECUTED_CHECK);

  const findings = await scanForHederaScheduleExecutedRisks(dir);

  assert.deepEqual(findings, []);
});
