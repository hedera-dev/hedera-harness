import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Optional override lets the same tests run against the untouched baseline.
const dist = path.resolve(process.env.HARNESS_TEST_DIST ?? "dist");
const { executeCommand, executeCommandOrThrow } = await import(pathToFileURL(path.join(dist, "command.js")).href);
const { runDeterministicValidation, isReadyForPlaywrightSmoke } = await import(pathToFileURL(path.join(dist, "validation/index.js")).href);
const { computeInstallFingerprint, readCachedInstallFingerprint } = await import(pathToFileURL(path.join(dist, "validation/installFingerprint.js")).href);
const posixOnly = { skip: process.platform === "win32", timeout: 15_000 };
const TIMEOUT_MS = 800;
const quote = value => `'${value.replaceAll("'", `'"'"'`)}'`;

async function fixture(t, { mode = "timeout", silent = false, exitCode = 0 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "check.cjs");
  await writeFile(script, `
const fs = require("node:fs");
fs.appendFileSync("invocations.txt", "run\\n");
const mode = ${JSON.stringify(mode)};
const code = ${exitCode};
if (mode === "timeout") {
  process.on("SIGTERM", () => {
    fs.appendFileSync("shutdown.txt", "SIGTERM\\n");
    ${silent ? "" : 'fs.writeSync(2, "cleanup finished\\n");'}
    process.exit(code);
  });
  setInterval(() => {}, 1000);
} else if (mode === "signal") {
  process.kill(process.pid, "SIGTERM");
} else {
  fs.writeSync(1, "check completed\\n");
  if (code !== 0) fs.writeSync(2, "check failed\\n");
  process.exit(code);
}
`);
  const commandsPath = path.join(dir, "commands.json");
  const staticPath = path.join(dir, "static.json");
  await writeFile(staticPath, "{}");
  await writeFile(path.join(dir, "package.json"), '{"name":"timeout-fixture","private":true}\n');
  const cache = path.join(dir, ".harness", "install.sha256");
  const spec = {
    schemaVersion: 2, projectRoot: dir, name: "timeout-regression", prdPaths: [],
    agent: "claude", generator: { provider: "command", command: process.execPath },
    validators: { staticPath, commandsPath }, requiredFiles: [], forbiddenFiles: [],
    maxAttempts: 1, logging: { jsonlPath: "unused.jsonl", notesPath: "unused.md" },
  };
  // POSIX exec avoids the shell being the process that reports termination.
  const command = `exec ${quote(process.execPath)} ${quote(script)}`;
  return {
    dir, script, cache,
    direct: { command: process.execPath, args: [script], cwd: dir, timeoutMs: TIMEOUT_MS },
    async validate(name = "build", options = {}) {
      await writeFile(commandsPath, JSON.stringify({ commands: [{ name, command, timeoutMs: TIMEOUT_MS }] }));
      return runDeterministicValidation(dir, spec, options);
    },
    async count() { return (await readFile(path.join(dir, "invocations.txt"), "utf8")).trim().split("\n").length; },
    async wasShutdown() { return (await readFile(path.join(dir, "shutdown.txt"), "utf8")).includes("SIGTERM"); },
  };
}

function assertExpiredCleanExit(result) {
  assert.equal(result.timedOut, true, "must exercise a real harness deadline");
  assert.equal(result.exitCode, 0, "must exercise a clean shutdown, not a signal exit");
  assert.equal(result.signal, null, "raw process evidence must remain unchanged");
  assert.ok(result.durationMs >= TIMEOUT_MS);
}

test("ordinary successful commands still resolve with intact output", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: "exit" });
  const result = await executeCommandOrThrow(f.direct);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "check completed\n");
});

test("ordinary nonzero commands still reject with stderr", { timeout: 15_000 }, async t => {
  const f = await fixture(t, { mode: "exit", exitCode: 7 });
  await assert.rejects(executeCommandOrThrow(f.direct), /exited with code 7: check failed/);
});

test("raw execution preserves both the timeout and actual zero exit code", posixOnly, async t => {
  const f = await fixture(t);
  const result = await executeCommand(f.direct);
  assertExpiredCleanExit(result);
  assert.equal(await f.wasShutdown(), true);
});

test("throwing helper rejects a timeout even when SIGTERM cleanup exits zero", posixOnly, async t => {
  const f = await fixture(t);
  await assert.rejects(executeCommandOrThrow(f.direct), /timed out: cleanup finished/);
  assert.equal(await f.wasShutdown(), true);
});

test("throwing helper reports a silent clean-exit timeout", posixOnly, async t => {
  const f = await fixture(t, { silent: true });
  await assert.rejects(executeCommandOrThrow(f.direct), /timed out\.$/);
});

test("ASSERT fails an expired check, preserving raw process evidence", posixOnly, async t => {
  const f = await fixture(t);
  const validation = await f.validate();
  assertExpiredCleanExit(validation.commandResults[0]);
  assert.equal(validation.passed, false);
  assert.equal(validation.findings.length, 1);
  assert.equal(validation.findings[0].id, "command:build");
  assert.equal(validation.findings[0].category, "commands");
  assert.match(validation.findings[0].message, /timed out/);
  assert.match(validation.findings[0].details, /cleanup finished/);
});

test("a timed-out check cannot unlock the Playwright smoke gate", posixOnly, async t => {
  const f = await fixture(t);
  const validation = await f.validate();
  assertExpiredCleanExit(validation.commandResults[0]);
  assert.equal(isReadyForPlaywrightSmoke(validation), false);
});

test("ASSERT explains a timeout even when the command emits nothing", posixOnly, async t => {
  const f = await fixture(t, { silent: true });
  const validation = await f.validate();
  assertExpiredCleanExit(validation.commandResults[0]);
  assert.equal(validation.findings.length, 1);
  assert.match(validation.findings[0].message, /timed out/);
});

test("timed-out install does not create a successful-install fingerprint", posixOnly, async t => {
  const f = await fixture(t);
  const validation = await f.validate("install", { installCachePath: f.cache });
  assertExpiredCleanExit(validation.commandResults[0]);
  assert.equal(existsSync(f.cache), false);
  assert.equal(await readCachedInstallFingerprint(f.cache), undefined);
});

test("the next attempt reruns a timed-out install instead of trusting a false cache", posixOnly, async t => {
  const f = await fixture(t);
  const first = await f.validate("install", { installCachePath: f.cache });
  assertExpiredCleanExit(first.commandResults[0]);
  const second = await f.validate("install", { installCachePath: f.cache });
  assert.equal(await f.count(), 2);
  assert.equal(second.commandResults[0].skipped, undefined);
  assertExpiredCleanExit(second.commandResults[0]);
  assert.equal(second.passed, false);
});

test("successful installs still write and reuse their fingerprint", posixOnly, async t => {
  const f = await fixture(t, { mode: "exit" });
  const first = await f.validate("install", { installCachePath: f.cache });
  assert.equal(first.passed, true);
  assert.equal(await readCachedInstallFingerprint(f.cache), await computeInstallFingerprint(f.dir));
  const second = await f.validate("install", { installCachePath: f.cache });
  assert.equal(second.passed, true);
  assert.equal(second.commandResults[0].skipped, true);
  assert.equal(await f.count(), 1);
});

test("nonzero installs continue to fail and never populate the cache", posixOnly, async t => {
  const f = await fixture(t, { mode: "exit", exitCode: 7 });
  const validation = await f.validate("install", { installCachePath: f.cache });
  assert.equal(validation.passed, false);
  assert.equal(validation.commandResults[0].timedOut, false);
  assert.equal(validation.commandResults[0].exitCode, 7);
  assert.equal(validation.findings[0].message, "Validation command failed: install");
  assert.match(validation.findings[0].details, /check failed/);
  assert.equal(existsSync(f.cache), false);
});

test("ordinary successful checks still open the smoke gate", posixOnly, async t => {
  const f = await fixture(t, { mode: "exit" });
  const validation = await f.validate();
  assert.equal(validation.passed, true);
  assert.equal(isReadyForPlaywrightSmoke(validation), true);
});

test("signal termination without a harness timeout remains a failure", posixOnly, async t => {
  const f = await fixture(t, { mode: "signal" });
  const validation = await f.validate();
  assert.equal(validation.commandResults[0].timedOut, false);
  assert.equal(validation.commandResults[0].signal, "SIGTERM");
  assert.equal(validation.passed, false);
  assert.equal(isReadyForPlaywrightSmoke(validation), false);
});
