import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const artifactsUrl = pathToFileURL(path.resolve("dist/runArtifacts.js")).href;
const {
  createRunLayout,
  openRunLayout,
  resolveContinueRunDirectory,
  lastAttemptNumber,
  nextCycleNumber,
  LAYOUT_MODE_ISOLATED_RUN,
} = await import(artifactsUrl);

/**
 * Regression: isolated `run` + `--continue` keep accumulating in the same run
 * directory, bump attempt numbers, and open the same workspace without reseeding.
 */
test("run/continue reopen preserves isolated workspace and advances attempt budget", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "harness-run-continue-"));
  const logging = {
    jsonlPath: path.join(projectRoot, "runs", "harness.log.jsonl"),
    notesPath: path.join(projectRoot, "runs", "harness-notes.md"),
  };

  // Fresh run layout (createRunLayout path used by runHarness)
  const fresh = await createRunLayout(projectRoot, "hedera-demo-from-main", logging);
  assert.equal(fresh.mode, LAYOUT_MODE_ISOLATED_RUN);
  await mkdir(fresh.workspacePath, { recursive: true });
  await writeFile(path.join(fresh.workspacePath, "README.md"), "# seeded\n");
  await writeFile(
    fresh.reportPath,
    JSON.stringify(
      {
        seedRepo: "https://github.com/hedera-dev/scaffold-hbar.git",
        seedRef: "main",
        seedCommitSha: "abc123def456",
        attempts: 2,
        passed: false,
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(fresh.logsDirectory, "generator-attempt-1.log"), "a\n");
  await writeFile(path.join(fresh.logsDirectory, "repair-attempt-2.log"), "b\n");

  // CLI: --continue <run-dir>
  const fromFlag = resolveContinueRunDirectory({ continueRunDirectory: fresh.runDirectory });
  assert.equal(fromFlag, fresh.runDirectory);

  // CLI: --workspace .../workspace (legacy convenience)
  const fromWorkspace = resolveContinueRunDirectory({ workspacePath: fresh.workspacePath });
  assert.equal(fromWorkspace, fresh.runDirectory);

  const continued = await openRunLayout(fromFlag, logging);
  assert.equal(continued.mode, LAYOUT_MODE_ISOLATED_RUN);
  assert.equal(continued.runDirectory, fresh.runDirectory);
  assert.equal(continued.workspacePath, fresh.workspacePath);

  const startingAttempt = (await lastAttemptNumber(continued.logsDirectory)) + 1;
  const cycle = await nextCycleNumber(continued.reportsDirectory);
  assert.equal(startingAttempt, 3);
  assert.equal(cycle, 1);

  // After a continue kick finishes, cycle report exists and next continue advances again
  await writeFile(path.join(continued.logsDirectory, "continue-cycle-1-attempt-3.log"), "c\n");
  await writeFile(path.join(continued.reportsDirectory, "cycle-1.json"), "{}\n");

  const again = await openRunLayout(continued.runDirectory, logging);
  assert.equal((await lastAttemptNumber(again.logsDirectory)) + 1, 4);
  assert.equal(await nextCycleNumber(again.reportsDirectory), 2);
  assert.equal(again.workspacePath, fresh.workspacePath);
});

test("continue refuses to open a run directory without a workspace", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "harness-continue-missing-ws-"));
  const logging = {
    jsonlPath: path.join(projectRoot, "runs", "harness.log.jsonl"),
    notesPath: path.join(projectRoot, "runs", "harness-notes.md"),
  };
  const layout = await createRunLayout(projectRoot, "missing-ws", logging);

  await assert.rejects(() => openRunLayout(layout.runDirectory, logging), (error) => {
    assert.equal(error?.code, "ENOENT");
    return true;
  });
});
