import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { readRunStatus, formatRunStatus, formatDuration } = await import(
  pathToFileURL(path.resolve("dist/status.js")).href
);
const { parseCliArgs } = await import(pathToFileURL(path.resolve("dist/cli.js")).href);

const RUN_ID = "20260913-101500-abc";

/**
 * Build a workspace holding one run directory.
 *
 * `layout.json` must name the workspace, exactly as the run loop writes it —
 * that is what ties a run directory to the project it belongs to.
 */
async function makeRun(status, { report, runId = RUN_ID, workspaceInMeta } = {}) {
  const workspacePath = await makeOsTempDir("harness-status-");
  const runDirectory = path.join(workspacePath, ".harness", "runs", runId);
  await mkdir(path.join(runDirectory, "reports"), { recursive: true });

  await writeFile(
    path.join(runDirectory, "layout.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "in-place-run",
      workspacePath: workspaceInMeta ?? workspacePath,
    }),
    "utf8",
  );

  if (status) {
    await writeFile(path.join(runDirectory, "status.json"), JSON.stringify(status), "utf8");
  }
  if (report) {
    await writeFile(
      path.join(runDirectory, "reports", "report.json"),
      JSON.stringify(report),
      "utf8",
    );
  }

  return { workspacePath, runDirectory };
}

function isoSecondsAgo(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

// ── Locating the run ─────────────────────────────────────────────────────────

test("a workspace with no runs reports that plainly instead of failing", async () => {
  const workspacePath = await makeOsTempDir("harness-status-");
  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });

  assert.equal(snapshot.runDirectory, null);
  assert.equal(snapshot.status, null);
  assert.match(formatRunStatus(snapshot), /No harness run found/);
});

test("a run directory belonging to another workspace is ignored", async () => {
  const { workspacePath } = await makeRun(
    { phase: "finished", passed: true },
    { workspaceInMeta: path.join("C:", "some", "other", "project") },
  );

  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });
  assert.equal(snapshot.runDirectory, null, "layout.json must match this workspace");
});

test("the newest run directory wins when several exist", async () => {
  const { workspacePath } = await makeRun({ phase: "started" }, { runId: "20260101-000000-old" });

  const runsRoot = path.join(workspacePath, ".harness", "runs");
  const newer = path.join(runsRoot, "20260913-101500-new");
  await mkdir(newer, { recursive: true });
  await writeFile(
    path.join(newer, "layout.json"),
    JSON.stringify({ schemaVersion: 1, mode: "in-place-run", workspacePath }),
    "utf8",
  );
  await writeFile(
    path.join(newer, "status.json"),
    JSON.stringify({ phase: "generator_running", attempt: 1 }),
    "utf8",
  );

  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });
  assert.equal(path.basename(snapshot.runDirectory), "20260913-101500-new");
  assert.equal(snapshot.status.phase, "generator_running");
});

test("reading status never creates directories in the workspace", async () => {
  // The run loop's own resolver mkdirs as a side effect; a reporting command
  // must leave a workspace it only inspected exactly as it found it.
  const workspacePath = await makeOsTempDir("harness-status-");
  await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });

  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(workspacePath), [], "no directories should be created");
});

// ── Phases ───────────────────────────────────────────────────────────────────

test("a live generator run reports stage, attempt, activity and tool counts", async () => {
  const { workspacePath } = await makeRun({
    updatedAt: isoSecondsAgo(5),
    phase: "generator_running",
    stage: "GENERATE",
    attempt: 2,
    elapsedSeconds: 252,
    lastActivity: "TOOL START edit app/page.tsx",
    toolCallsStarted: 37,
    toolCallsCompleted: 36,
    activityLogPath: "/runs/abc/logs/generator-attempt-2.activity.log",
  });

  const rendered = formatRunStatus(
    await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath }),
  );

  assert.match(rendered, /phase\s+GENERATE — generating/);
  assert.match(rendered, /attempt\s+2/);
  assert.match(rendered, /elapsed\s+4m 12s/);
  assert.match(rendered, /activity\s+TOOL START edit app\/page\.tsx/);
  assert.match(rendered, /tools\s+37 started, 36 completed/);
  assert.match(rendered, /agent log\s+/);
});

test("a repair attempt is distinguished from a first generate", async () => {
  const { workspacePath } = await makeRun({
    updatedAt: isoSecondsAgo(2),
    phase: "repair_running",
    stage: "GENERATE",
    attempt: 3,
  });

  const rendered = formatRunStatus(
    await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath }),
  );
  assert.match(rendered, /phase\s+GENERATE — repairing/);
});

test("a finished run reports the verdict, findings and report path", async () => {
  const { workspacePath } = await makeRun(
    {
      updatedAt: isoSecondsAgo(30),
      phase: "finished",
      passed: true,
      attempts: 2,
      openFindingIds: [],
    },
    {
      report: {
        specName: "my-feature",
        passed: true,
        attempts: 2,
        maxAttempts: 3,
        openFindingIds: [],
        fixedFindingIds: ["static:missing-page", "commands:build"],
        validation: { findings: [] },
      },
    },
  );

  const rendered = formatRunStatus(
    await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath }),
  );

  assert.match(rendered, /phase\s+finished — PASSED after 2 attempt\(s\)/);
  assert.match(rendered, /findings\s+0 open, 2 fixed/);
  assert.match(rendered, /report\s+.*report\.json/);
});

test("a failed attempt and an infrastructure abort are reported differently", async () => {
  const { workspacePath: failed } = await makeRun({
    updatedAt: isoSecondsAgo(5),
    phase: "validated",
    attempt: 1,
    passed: false,
    openFindingIds: ["commands:build"],
    fixedFindingIds: [],
  });
  const failedRender = formatRunStatus(
    await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath: failed }),
  );
  assert.match(failedRender, /phase\s+validated — attempt FAILED/);
  assert.match(failedRender, /findings\s+1 open/);
  assert.doesNotMatch(failedRender, /infrastructure/);

  const { workspacePath: aborted } = await makeRun({
    updatedAt: isoSecondsAgo(5),
    phase: "validated",
    attempt: 1,
    passed: false,
    infrastructureFailure: true,
  });
  const abortedRender = formatRunStatus(
    await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath: aborted }),
  );
  assert.match(abortedRender, /not an app defect/);
});

test("a run directory with no status file still reports the run", async () => {
  const { workspacePath } = await makeRun(null);
  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });

  assert.ok(snapshot.runDirectory);
  assert.equal(snapshot.status, null);
  assert.match(formatRunStatus(snapshot), /no status written yet/);
});

// ── Staleness ────────────────────────────────────────────────────────────────

test("a running phase that stops heartbeating is flagged as stale", async () => {
  const { workspacePath } = await makeRun({
    updatedAt: isoSecondsAgo(45 * 60),
    phase: "generator_running",
    attempt: 1,
  });

  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });
  assert.equal(snapshot.stale, true);
  assert.match(formatRunStatus(snapshot), /no heartbeat, the run may have stopped/);
});

test("a finished run is never stale, however old it is", async () => {
  const { workspacePath } = await makeRun({
    updatedAt: isoSecondsAgo(90 * 24 * 3600),
    phase: "finished",
    passed: true,
    attempts: 1,
  });

  const snapshot = await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath });
  assert.equal(snapshot.stale, false, "a finished run has nothing left to heartbeat");
  assert.doesNotMatch(formatRunStatus(snapshot), /may have stopped/);
});

test("a fresh heartbeat is not stale", async () => {
  const { workspacePath } = await makeRun({
    updatedAt: isoSecondsAgo(10),
    phase: "generator_running",
    attempt: 1,
  });

  assert.equal(
    (await readRunStatus({ specPath: ".harness/spec.yaml", workspacePath })).stale,
    false,
  );
});

// ── Duration formatting ──────────────────────────────────────────────────────

test("durations read naturally at every scale", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(60), "1m");
  assert.equal(formatDuration(252), "4m 12s");
  assert.equal(formatDuration(3600), "1h");
  assert.equal(formatDuration(3900), "1h 5m");
});

// ── CLI wiring ───────────────────────────────────────────────────────────────

test("status parses with a default spec, a workspace, and its own flags", () => {
  assert.deepEqual(parseCliArgs(["status"]), {
    command: "status",
    options: { specPath: ".harness/spec.yaml" },
  });

  const parsed = parseCliArgs(["status", ".harness/other.yaml", "--workspace", "/tmp/app", "--watch"]);
  assert.equal(parsed.command, "status");
  assert.equal(parsed.options.specPath, ".harness/other.yaml");
  assert.equal(parsed.options.workspacePath, "/tmp/app");
  assert.equal(parsed.options.watch, true);

  assert.equal(parseCliArgs(["status", "--json"]).options.json, true);
});

test("status-only flags are rejected on other commands", () => {
  assert.throws(() => parseCliArgs(["run", "--watch"]), /only valid for status/);
  assert.throws(() => parseCliArgs(["doctor", "--json"]), /only valid for status/);
  assert.throws(() => parseCliArgs(["status", "--recipe-only"]), /only valid for doctor/);
});
