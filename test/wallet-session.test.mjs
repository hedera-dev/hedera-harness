import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const session = await import(pathToFileURL(path.resolve("dist/walletSession.js")).href);

test("parseCliArgs accepts wallet session start snapshot fill mm", () => {
  const start = cli.parseCliArgs(["wallet", "session", "start", "--url", "http://127.0.0.1:3000"]);
  assert.equal(start.walletOptions?.subcommand, "session");
  assert.equal(start.walletOptions?.sessionAction, "start");
  assert.equal(start.walletOptions?.url, "http://127.0.0.1:3000");

  const fill = cli.parseCliArgs([
    "wallet",
    "session",
    "fill",
    "--testid",
    "pay-amount",
    "--value",
    "1",
  ]);
  assert.equal(fill.walletOptions?.sessionAction, "fill");
  assert.equal(fill.walletOptions?.testId, "pay-amount");
  assert.equal(fill.walletOptions?.value, "1");

  const mm = cli.parseCliArgs(["wallet", "session", "mm", "--action", "confirm"]);
  assert.equal(mm.walletOptions?.sessionAction, "mm");
  assert.equal(mm.walletOptions?.mmAction, "confirm");
});

test("wallet session status is down without a live process", async () => {
  const root = await makeTestTempDir("wallet-session-");
  const text = await session.runWalletSession(root, "status");
  assert.match(text, /session=down/);
  assert.doesNotMatch(text, /0x[a-fA-F0-9]{64}/);
});

test("formatSessionReport and state file never look like a vault", async () => {
  const root = await makeTestTempDir("wallet-session-state-");
  const dir = path.join(root, ".harness");
  await mkdir(dir, { recursive: true });
  await writeFile(
    session.sessionStatePath(root),
    `${JSON.stringify({ pid: 1, port: 17374, url: "http://127.0.0.1:3000", workspace: root, phase: "up" }, null, 2)}\n`,
  );
  const state = session.readSessionState(root);
  assert.equal(state?.port, 17374);
  assert.equal(state?.phase, "up");
  const printed = session.formatSessionReport(["session=up", "value=0.1"]);
  assert.match(printed, /value=0\.1/);
  assert.doesNotMatch(printed, /privateKey/i);
});
