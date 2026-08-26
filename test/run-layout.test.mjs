import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const distUrl = pathToFileURL(path.resolve("dist/runArtifacts.js")).href;
const {
  createSessionLayout,
  openRunLayout,
  readLayoutMeta,
  resolveArtifactDirsForWorkspace,
  resolveRunDirectoryForWorkspace,
  lastAttemptNumber,
  LAYOUT_MODE_IN_PLACE_RUN,
} = await import(distUrl);

async function nextCycleFromReports(reportsDirectory) {
  let maxCycle = 0;
  try {
    const entries = await readdir(reportsDirectory);
    for (const entry of entries) {
      const match = /^cycle-(\d+)\.json$/.exec(entry);
      if (match) {
        maxCycle = Math.max(maxCycle, Number.parseInt(match[1], 10));
      }
    }
  } catch {
    // empty / missing
  }
  return maxCycle + 1;
}

function loggingPaths(root) {
  return {
    jsonlPath: path.join(root, ".harness", "runs", "harness.log.jsonl"),
    notesPath: path.join(root, ".harness", "runs", "harness-notes.md"),
  };
}

test("in-place-run layout keeps code in cwd and artifacts under .harness/runs/<id>", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-run-"));
  const layout = await createSessionLayout(cwd, "run-demo", loggingPaths(cwd));

  assert.equal(layout.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(layout.workspacePath, path.resolve(cwd));
  assert.ok(layout.runDirectory.startsWith(path.join(cwd, ".harness", "runs") + path.sep));
  assert.equal(layout.promptsDirectory, path.join(layout.runDirectory, "prompts"));
  assert.equal(layout.logsDirectory, path.join(layout.runDirectory, "logs"));
  assert.equal(layout.reportsDirectory, path.join(layout.runDirectory, "reports"));
  assert.equal(layout.cacheDirectory, path.join(layout.runDirectory, "cache"));
  assert.equal(layout.reportPath, path.join(layout.reportsDirectory, "report.json"));

  const meta = await readLayoutMeta(layout.runDirectory);
  assert.deepEqual(meta, {
    schemaVersion: 1,
    mode: LAYOUT_MODE_IN_PLACE_RUN,
    workspacePath: path.resolve(cwd),
  });

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(cwd));
  assert.equal(reopened.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(reopened.workspacePath, path.resolve(cwd));
  assert.equal(reopened.runDirectory, layout.runDirectory);
});

test("readLayoutMeta normalizes the legacy in-place-extend mode", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-legacy-mode-"));
  const layout = await createSessionLayout(cwd, "legacy", loggingPaths(cwd));

  await writeFile(
    path.join(layout.runDirectory, "layout.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: "in-place-extend",
      workspacePath: path.resolve(cwd),
    }),
  );

  const meta = await readLayoutMeta(layout.runDirectory);
  assert.equal(meta.mode, LAYOUT_MODE_IN_PLACE_RUN);
});

test("readLayoutMeta rejects an unknown layout mode", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-bad-mode-"));
  const layout = await createSessionLayout(cwd, "bad", loggingPaths(cwd));

  await writeFile(
    path.join(layout.runDirectory, "layout.json"),
    JSON.stringify({ schemaVersion: 1, mode: "isolated-run", workspacePath: cwd }),
  );

  assert.equal(await readLayoutMeta(layout.runDirectory), null);
});

test("resolveArtifactDirsForWorkspace prefers layout.json over basename heuristics", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-artifacts-"));
  const layout = await createSessionLayout(cwd, "artifacts", loggingPaths(cwd));

  const dirs = await resolveArtifactDirsForWorkspace(cwd);
  assert.equal(dirs.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(dirs.runDirectory, layout.runDirectory);
  assert.equal(dirs.logsDirectory, layout.logsDirectory);
  assert.equal(dirs.promptsDirectory, layout.promptsDirectory);

  const runDir = await resolveRunDirectoryForWorkspace(cwd);
  assert.equal(runDir, layout.runDirectory);
});

test("workspace without harness metadata falls back to ad-hoc artifact dirs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-adhoc-"));

  const dirs = await resolveArtifactDirsForWorkspace(cwd);
  assert.equal(dirs.mode, "ad-hoc");
  assert.equal(dirs.runDirectory, null);
  assert.equal(dirs.logsDirectory, path.join(cwd, ".harness-semantic", "logs"));
  assert.equal(dirs.promptsDirectory, path.join(cwd, ".harness-semantic", "prompts"));
});

test("continue attempt and cycle numbering accumulate across kicks", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-continue-nums-"));
  const layout = await createSessionLayout(cwd, "continue-demo", loggingPaths(cwd));

  assert.equal(await lastAttemptNumber(layout.logsDirectory), 0);
  assert.equal(await nextCycleFromReports(layout.reportsDirectory), 1);

  await writeFile(path.join(layout.logsDirectory, "generator-attempt-1.log"), "ok\n");
  await writeFile(path.join(layout.logsDirectory, "validation-attempt-1.json"), "{}\n");
  await writeFile(path.join(layout.logsDirectory, "repair-attempt-2.log"), "ok\n");
  await writeFile(path.join(layout.reportsDirectory, "report.json"), JSON.stringify({}));

  assert.equal(await lastAttemptNumber(layout.logsDirectory), 2);
  assert.equal(await nextCycleFromReports(layout.reportsDirectory), 1);

  await writeFile(path.join(layout.reportsDirectory, "cycle-1.json"), "{}\n");
  assert.equal(await nextCycleFromReports(layout.reportsDirectory), 2);

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(cwd));
  assert.equal(reopened.mode, LAYOUT_MODE_IN_PLACE_RUN);
  const startingAttempt = (await lastAttemptNumber(reopened.logsDirectory)) + 1;
  const cycle = await nextCycleFromReports(reopened.reportsDirectory);
  assert.equal(startingAttempt, 3);
  assert.equal(cycle, 2);

  // Simulate a continue kick writing a cycle report plus another attempt.
  await writeFile(path.join(reopened.logsDirectory, "continue-cycle-2-attempt-3.txt"), "prompt\n");
  await writeFile(path.join(reopened.reportsDirectory, "cycle-2.json"), "{}\n");
  assert.equal(await lastAttemptNumber(reopened.logsDirectory), 3);
  assert.equal(await nextCycleFromReports(reopened.reportsDirectory), 3);
});

test("layout.json round-trips an explicit workspace path", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-meta-"));
  const layout = await createSessionLayout(cwd, "meta", loggingPaths(cwd));

  const raw = JSON.parse(await readFile(path.join(layout.runDirectory, "layout.json"), "utf8"));
  assert.equal(raw.mode, LAYOUT_MODE_IN_PLACE_RUN);

  // Metadata must win over any path heuristic.
  const customWorkspace = path.join(layout.runDirectory, "app-code");
  await mkdir(customWorkspace, { recursive: true });
  await writeFile(
    path.join(layout.runDirectory, "layout.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: LAYOUT_MODE_IN_PLACE_RUN,
      workspacePath: customWorkspace,
    }),
  );

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(cwd));
  assert.equal(reopened.workspacePath, customWorkspace);

  const dirs = await resolveArtifactDirsForWorkspace(customWorkspace);
  assert.equal(dirs.runDirectory, layout.runDirectory);
  assert.equal(dirs.mode, LAYOUT_MODE_IN_PLACE_RUN);
});
