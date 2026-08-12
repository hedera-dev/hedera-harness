import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { executeCommand } = await import(pathToFileURL(path.resolve("dist/command.js")).href);
const { createDevServerSession } = await import(
  pathToFileURL(path.resolve("dist/validation/devServer.js")).href
);

/** True while the pid exists. Signal 0 checks liveness without delivering anything. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

// These drive real child processes, so they are slower than the unit tests.
// They cover the one thing unit tests cannot: that a timeout actually kills.

test("executeCommand escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const dir = await makeOsTempDir("harness-sigterm-");
  const pidFile = path.join(dir, "shell.pid");

  const result = await executeCommand({
    // Traps and discards SIGTERM: before the escalation fix this never settled.
    command: `echo $$ > "${pidFile}"; trap '' TERM; sleep 30`,
    cwd: dir,
    shell: true,
    timeoutMs: 1_000,
  });

  assert.equal(result.timedOut, true, "should report a timeout");

  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(pid), "shell should have written its pid");
  assert.ok(await waitForDeath(pid), `shell ${pid} should have been killed`);
});

test("executeCommand timeout kills grandchildren, not just the shell", async () => {
  const dir = await makeOsTempDir("harness-tree-");
  const childPidFile = path.join(dir, "child.pid");

  const result = await executeCommand({
    // `sleep` here stands in for yarn/next: signalling only `sh` would orphan it.
    command: `sleep 30 & echo $! > "${childPidFile}"; wait`,
    cwd: dir,
    shell: true,
    timeoutMs: 1_500,
  });

  assert.equal(result.timedOut, true);

  const childPid = Number.parseInt((await readFile(childPidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(childPid), "background job should have written its pid");
  assert.ok(await waitForDeath(childPid), `grandchild ${childPid} should have been killed`);
});

test("executeCommand returns normally for a command that exits on its own", async () => {
  const dir = await makeOsTempDir("harness-normal-");

  const result = await executeCommand({
    command: `echo hello`,
    cwd: dir,
    shell: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
});

test("createDevServerSession tears down the server when readiness fails", async () => {
  const dir = await makeOsTempDir("harness-devserver-");
  const pidFile = path.join(dir, "server.pid");

  // Reports a Local URL so detection succeeds, but never listens — so the
  // readiness probe fails while the process is still running. Before the fix
  // this left the process group alive holding the port.
  await assert.rejects(
    () =>
      createDevServerSession(
        dir,
        {
          command: `echo $$ > "${pidFile}"; echo "Local: http://127.0.0.1:1"; sleep 30`,
          configuredUrl: "http://127.0.0.1:1",
          timeoutMs: 1_500,
        },
        "test",
      ),
    /did not become ready/,
  );

  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(pid), "server should have written its pid");
  assert.ok(await waitForDeath(pid), `dev server ${pid} should have been torn down`);
});
