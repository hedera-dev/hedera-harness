import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { announceAttempt } = await import(pathToFileURL(path.resolve("dist/attemptReporting.js")).href);

/**
 * The prompt `announceAttempt` writes is what reaches the generator/repair LLM and a plaintext
 * file on disk — the actual sink a leaked signer key would exit through, not just a finding's
 * `details` field (already redacted at the source; this is defense in depth for whatever
 * doesn't redact there). Never trust this by reading the source — write a prompt containing a
 * real-shaped key, read the persisted file back, and assert the key genuinely isn't in it.
 */
async function makeLayout() {
  const runDirectory = await makeTestTempDir("attempt-reporting-");
  const promptsDirectory = path.join(runDirectory, "prompts");
  await mkdir(promptsDirectory, { recursive: true });
  return {
    mode: "in-place-run",
    runDirectory,
    workspacePath: runDirectory,
    promptsDirectory,
    logsDirectory: runDirectory,
    reportsDirectory: runDirectory,
    cacheDirectory: runDirectory,
    reportPath: path.join(runDirectory, "report.json"),
    jsonlLogPath: path.join(runDirectory, "harness.jsonl"),
    notesLogPath: path.join(runDirectory, "notes.md"),
  };
}

test("announceAttempt redacts the primary chainSigner's key from the persisted prompt file", async () => {
  const layout = await makeLayout();
  const secretKey = `0x${"a".repeat(64)}`;
  const prompt = `Fix this. The signer used was ${secretKey}. Also bare form: ${"a".repeat(64)}.`;

  await announceAttempt({
    layout,
    kind: "repair",
    attempt: 1,
    attemptsThisCycle: 1,
    prompt,
    chainSigner: { accountId: "0.0.1", privateKeyHex: secretKey, evmAddress: "0x1", network: "testnet" },
  });

  const written = await readFile(path.join(layout.promptsDirectory, "repair-attempt-1.txt"), "utf8");
  assert.ok(!written.includes(secretKey), "0x-prefixed key leaked into the persisted prompt file");
  assert.ok(!written.includes("a".repeat(64)), "bare-hex key leaked into the persisted prompt file");
  assert.ok(written.includes("<redacted by hedera-harness>"));
});

test("announceAttempt redacts every named actor's key too, not just the primary signer", async () => {
  const layout = await makeLayout();
  const attackerKey = `0x${"b".repeat(64)}`;
  const prompt = `Something went wrong for actor with key ${attackerKey}.`;

  await announceAttempt({
    layout,
    kind: "generate",
    attempt: 1,
    attemptsThisCycle: 1,
    prompt,
    chainActors: { attacker: { accountId: "0.0.2", privateKeyHex: attackerKey, evmAddress: "0x2", network: "testnet" } },
  });

  const written = await readFile(path.join(layout.promptsDirectory, "generator-attempt-1.txt"), "utf8");
  assert.ok(!written.includes(attackerKey), "actor's key leaked into the persisted prompt file");
  assert.ok(written.includes("<redacted by hedera-harness>"));
});

test("announceAttempt with no signer material at all still writes the prompt unchanged", async () => {
  const layout = await makeLayout();
  await announceAttempt({ layout, kind: "generate", attempt: 1, attemptsThisCycle: 1, prompt: "plain prompt, no secrets" });
  const written = await readFile(path.join(layout.promptsDirectory, "generator-attempt-1.txt"), "utf8");
  assert.equal(written.trim(), "plain prompt, no secrets");
});
