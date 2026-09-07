import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const tasks = await import(pathToFileURL(path.resolve("dist/harnessTasks.js")).href);
const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);

test("parseCliArgs accepts tasks status and done --id", () => {
  const status = cli.parseCliArgs(["tasks", "status", "--workspace", "D:\\app"]);
  assert.equal(status.command, "tasks");
  assert.equal(status.tasksOptions?.subcommand, "status");
  assert.equal(status.tasksOptions?.workspace, "D:\\app");

  const done = cli.parseCliArgs(["tasks", "done", "--id", "T1"]);
  assert.equal(done.tasksOptions?.subcommand, "done");
  assert.equal(done.tasksOptions?.taskId, "T1");
});

test("parseCliArgs lists mcp and tasks in expected commands", () => {
  assert.throws(() => cli.parseCliArgs(["nope"]), /"mcp"/);
  assert.throws(() => cli.parseCliArgs(["nope"]), /"tasks"/);
});

test("inspectTasks missing file is not all_done", async () => {
  const root = await makeTestTempDir("tasks-missing-");
  const status = tasks.inspectTasks(root);
  assert.equal(status.exists, false);
  assert.equal(status.contracts, "none");
  const printed = tasks.formatTasksStatus(status);
  assert.match(printed, /file=missing/);
  assert.match(printed, /all_done=false/);
  assert.match(printed, /contracts=none/);
  assert.match(printed, /hardhat=skip/);
  assert.match(printed, /assert=next-only/);
  assert.doesNotMatch(printed, /all_done=true/);
});

test("inspectTasks reports next pending work unit", async () => {
  const root = await makeTestTempDir("tasks-next-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(
    path.join(root, ".harness", "tasks.md"),
    `# Tasks
Increment: .harness/prd.md

- [x] T1: History list
- [ ] T2: Empty state
- [ ] T3: Connect visible
`,
  );
  const status = tasks.inspectTasks(root);
  assert.equal(status.pending.length, 2);
  assert.equal(status.next?.id, "T2");
  const printed = tasks.formatTasksStatus(status);
  assert.match(printed, /next=T2/);
  assert.match(printed, /all_done=false/);
  assert.match(printed, /done=T1 History list/);
  assert.match(printed, /todo=T2 Empty state/);
});

test("markTaskDone checks the box and preserves other lines", async () => {
  const root = await makeTestTempDir("tasks-done-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  const file = path.join(root, ".harness", "tasks.md");
  await writeFile(
    file,
    `# Tasks
- [ ] T1: First behavior
- [ ] T2: Second behavior
`,
  );
  const after = tasks.markTaskDone(root, "T1");
  assert.equal(after.next?.id, "T2");
  const body = await readFile(file, "utf8");
  assert.match(body, /- \[x\] T1: First behavior/);
  assert.match(body, /- \[ \] T2: Second behavior/);
  assert.match(body, /# Tasks/);
});

test("markTaskDone of an already-checked box is a no-op success", async () => {
  const root = await makeTestTempDir("tasks-already-done-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "tasks.md"), "- [x] T1: Already shipped\n");
  const after = tasks.markTaskDone(root, "T1");
  assert.equal(after.pending.length, 0);
  assert.match(tasks.formatTasksStatus(after), /all_done=true/);
});

test("markTaskDone of the last task reports all_done", async () => {
  const root = await makeTestTempDir("tasks-all-done-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "tasks.md"), "- [ ] T1: Only unit\n");
  const after = tasks.markTaskDone(root, "T1");
  assert.equal(after.pending.length, 0);
  assert.match(tasks.formatTasksStatus(after), /all_done=true/);
});

test("inspectTasks honors Contracts header over a payments PRD", async () => {
  const root = await makeTestTempDir("tasks-solidity-header-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# Payments only\nSend HBAR with RainbowKit.\n");
  await writeFile(
    path.join(root, ".harness", "tasks.md"),
    `# Tasks
Increment: .harness/prd.md
Contracts: solidity

- [ ] T1: Token create via HTS precompile
`,
  );
  const status = tasks.inspectTasks(root);
  assert.equal(status.contracts, "solidity");
  assert.match(tasks.formatTasksStatus(status), /hardhat=run/);
  assert.match(tasks.formatTasksStatus(status), /assert=next\+hardhat/);
});

test("inspectTasks infers solidity from a real PRD when tasks omit the header", async () => {
  const root = await makeTestTempDir("tasks-infer-prd-");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(
    path.join(root, ".harness", "prd.md"),
    "# HTS dashboard\n\nCall the HTS precompile at 0x167.\n",
  );
  await writeFile(path.join(root, ".harness", "tasks.md"), "# Tasks\n- [ ] T1: Dashboard\n");
  const status = tasks.inspectTasks(root);
  assert.equal(status.contracts, "solidity");
});

