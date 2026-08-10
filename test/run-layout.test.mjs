import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const distUrl = pathToFileURL(path.resolve("dist/runArtifacts.js")).href;
const {
  createRunLayout,
  createSessionLayout,
  openRunLayout,
  readLayoutMeta,
  resolveArtifactDirsForWorkspace,
  resolveContinueRunDirectory,
  resolveRunDirectoryForWorkspace,
  lastAttemptNumber,
  nextCycleNumber,
  LAYOUT_MODE_ISOLATED_RUN,
  LAYOUT_MODE_IN_PLACE_RUN,
} = await import(distUrl);

function loggingPaths(root) {
  return {
    jsonlPath: path.join(root, "runs", "harness.log.jsonl"),
    notesPath: path.join(root, "runs", "harness-notes.md"),
  };
}

test("isolated-run layout uses runs/<id>/workspace and persists mode metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-isolated-"));
  const layout = await createRunLayout(root, "demo-spec", loggingPaths(root));

  assert.equal(layout.mode, LAYOUT_MODE_ISOLATED_RUN);
  assert.equal(layout.workspacePath, path.join(layout.runDirectory, "workspace"));
  assert.ok(layout.runDirectory.startsWith(path.join(root, "runs") + path.sep));
  assert.equal(layout.promptsDirectory, path.join(layout.runDirectory, "prompts"));
  assert.equal(layout.logsDirectory, path.join(layout.runDirectory, "logs"));
  assert.equal(layout.reportsDirectory, path.join(layout.runDirectory, "reports"));
  assert.equal(layout.cacheDirectory, path.join(layout.runDirectory, "cache"));
  assert.equal(layout.reportPath, path.join(layout.reportsDirectory, "report.json"));

  // seedWorkspace requires the workspace path to be absent at create time
  await assert.rejects(() => access(layout.workspacePath));

  const meta = await readLayoutMeta(layout.runDirectory);
  assert.deepEqual(meta, {
    schemaVersion: 1,
    mode: LAYOUT_MODE_ISOLATED_RUN,
    workspacePath: layout.workspacePath,
  });

  await mkdir(layout.workspacePath, { recursive: true });
  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(root));
  assert.equal(reopened.mode, LAYOUT_MODE_ISOLATED_RUN);
  assert.equal(reopened.workspacePath, layout.workspacePath);
  assert.equal(reopened.runDirectory, layout.runDirectory);
});

test("in-place-run layout keeps code in cwd and artifacts under .harness/runs/<id>", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-run-"));
  const layout = await createSessionLayout(cwd, "run-demo", loggingPaths(cwd));

  assert.equal(layout.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(layout.workspacePath, path.resolve(cwd));
  assert.ok(layout.runDirectory.startsWith(path.join(cwd, ".harness", "runs") + path.sep));
  assert.equal(layout.logsDirectory, path.join(layout.runDirectory, "logs"));
  assert.equal(layout.cacheDirectory, path.join(layout.runDirectory, "cache"));

  const meta = await readLayoutMeta(layout.runDirectory);
  assert.equal(meta.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(meta.workspacePath, path.resolve(cwd));

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(cwd));
  assert.equal(reopened.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(reopened.workspacePath, path.resolve(cwd));
});

test("resolveArtifactDirsForWorkspace prefers layout.json over basename heuristics", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "harness-artifacts-"));
  const layout = await createSessionLayout(cwd, "artifacts", loggingPaths(cwd));

  // Rename would break basename===workspace; metadata must still win for isolated.
  // For extend, workspace basename is the temp folder name — not "workspace".
  const dirs = await resolveArtifactDirsForWorkspace(cwd);
  assert.equal(dirs.mode, LAYOUT_MODE_IN_PLACE_RUN);
  assert.equal(dirs.runDirectory, layout.runDirectory);
  assert.equal(dirs.logsDirectory, layout.logsDirectory);
  assert.equal(dirs.promptsDirectory, layout.promptsDirectory);

  const runDir = await resolveRunDirectoryForWorkspace(cwd);
  assert.equal(runDir, layout.runDirectory);
});

test("legacy isolated workspace without layout.json still resolves sibling logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-legacy-"));
  const runDirectory = path.join(root, "runs", "legacy-run");
  const workspacePath = path.join(runDirectory, "workspace");
  await mkdir(path.join(runDirectory, "logs"), { recursive: true });
  await mkdir(workspacePath, { recursive: true });

  const dirs = await resolveArtifactDirsForWorkspace(workspacePath);
  assert.equal(dirs.mode, LAYOUT_MODE_ISOLATED_RUN);
  assert.equal(dirs.runDirectory, runDirectory);
  assert.equal(dirs.logsDirectory, path.join(runDirectory, "logs"));
});

test("resolveContinueRunDirectory preserves run/continue CLI semantics", () => {
  const runDir = "/tmp/project/runs/2026-run-demo";
  assert.equal(
    resolveContinueRunDirectory({ continueRunDirectory: runDir }),
    path.resolve(runDir),
  );
  assert.equal(
    resolveContinueRunDirectory({ workspacePath: `${runDir}/workspace` }),
    path.resolve(runDir),
  );
  assert.equal(resolveContinueRunDirectory({ workspacePath: "/tmp/project" }), undefined);
  assert.equal(resolveContinueRunDirectory({}), undefined);
});

test("continue attempt and cycle numbering accumulate across kicks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-continue-nums-"));
  const layout = await createRunLayout(root, "continue-demo", loggingPaths(root));
  await mkdir(layout.workspacePath, { recursive: true });

  assert.equal(await lastAttemptNumber(layout.logsDirectory), 0);
  assert.equal(await nextCycleNumber(layout.reportsDirectory), 1);

  await writeFile(path.join(layout.logsDirectory, "generator-attempt-1.log"), "ok\n");
  await writeFile(path.join(layout.logsDirectory, "validation-attempt-1.json"), "{}\n");
  await writeFile(path.join(layout.logsDirectory, "repair-attempt-2.log"), "ok\n");
  await writeFile(
    path.join(layout.reportsDirectory, "report.json"),
    JSON.stringify({ seedRepo: "r", seedRef: "main", seedCommitSha: "abc" }),
  );

  assert.equal(await lastAttemptNumber(layout.logsDirectory), 2);
  assert.equal(await nextCycleNumber(layout.reportsDirectory), 1);

  await writeFile(path.join(layout.reportsDirectory, "cycle-1.json"), "{}\n");
  assert.equal(await nextCycleNumber(layout.reportsDirectory), 2);

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(root));
  assert.equal(reopened.mode, LAYOUT_MODE_ISOLATED_RUN);
  const startingAttempt = (await lastAttemptNumber(reopened.logsDirectory)) + 1;
  const cycle = await nextCycleNumber(reopened.reportsDirectory);
  assert.equal(startingAttempt, 3);
  assert.equal(cycle, 2);

  // Simulate continue kick writing cycle report + another attempt
  await writeFile(path.join(reopened.logsDirectory, "continue-cycle-2-attempt-3.txt"), "prompt\n");
  await writeFile(path.join(reopened.reportsDirectory, "cycle-2.json"), "{}\n");
  assert.equal(await lastAttemptNumber(reopened.logsDirectory), 3);
  assert.equal(await nextCycleNumber(reopened.reportsDirectory), 3);
});

test("layout.json round-trips mode for isolated reopen after workspace exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-meta-"));
  const layout = await createRunLayout(root, "meta", loggingPaths(root));
  await mkdir(layout.workspacePath, { recursive: true });

  const raw = JSON.parse(await readFile(path.join(layout.runDirectory, "layout.json"), "utf8"));
  assert.equal(raw.mode, LAYOUT_MODE_ISOLATED_RUN);

  // Corrupt basename heuristic by using metadata with an alternate workspace name
  const customWorkspace = path.join(layout.runDirectory, "app-code");
  await mkdir(customWorkspace, { recursive: true });
  await writeFile(
    path.join(layout.runDirectory, "layout.json"),
    JSON.stringify({
      schemaVersion: 1,
      mode: LAYOUT_MODE_ISOLATED_RUN,
      workspacePath: customWorkspace,
    }),
  );

  const reopened = await openRunLayout(layout.runDirectory, loggingPaths(root));
  assert.equal(reopened.workspacePath, customWorkspace);

  const dirs = await resolveArtifactDirsForWorkspace(customWorkspace);
  assert.equal(dirs.runDirectory, layout.runDirectory);
  assert.equal(dirs.mode, LAYOUT_MODE_ISOLATED_RUN);
});
