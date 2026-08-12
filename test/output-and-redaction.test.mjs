import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { BoundedOutput } = await import(pathToFileURL(path.resolve("dist/command.js")).href);
const { writePromptFile } = await import(pathToFileURL(path.resolve("dist/runArtifacts.js")).href);

test("BoundedOutput keeps short output verbatim", () => {
  const out = new BoundedOutput(16, 16);
  out.push(Buffer.from("hello "));
  out.push(Buffer.from("world"));

  assert.equal(out.toString(), "hello world");
  assert.equal(out.truncatedBytes, 0);
});

test("BoundedOutput keeps the head and the tail when output overruns", () => {
  const out = new BoundedOutput(10, 10);
  out.push(Buffer.from("HEAD______"));
  for (let i = 0; i < 20; i += 1) {
    out.push(Buffer.from(`middle-${i}-`));
  }
  out.push(Buffer.from("TAIL"));

  const text = out.toString();
  assert.match(text, /^HEAD______/);
  assert.match(text, /TAIL$/);
  assert.match(text, /omitted \d+ bytes of output/);
  assert.ok(out.truncatedBytes > 0);
});

test("BoundedOutput never drops the only retained tail chunk", () => {
  const out = new BoundedOutput(0, 4);
  out.push(Buffer.from("a-very-long-single-chunk"));

  assert.match(out.toString(), /a-very-long-single-chunk/);
});

test("writePromptFile redacts secrets from the persisted copy", async () => {
  const dir = await makeOsTempDir("harness-prompt-redact-");
  const promptPath = path.join(dir, "validator-attempt-1.txt");
  const key = "0xabc123def456";

  await writePromptFile(
    promptPath,
    `Private key (hex): ${key}\nlocalStorage.setItem("burnerWallet.pk", "${key}");`,
    [key],
  );

  const persisted = await readFile(promptPath, "utf8");
  assert.doesNotMatch(persisted, /0xabc123def456/);
  assert.match(persisted, /<redacted by hedera-harness>/);
  // Both occurrences are replaced, not just the first.
  assert.equal(persisted.split("<redacted by hedera-harness>").length - 1, 2);
});

test("writePromptFile tolerates undefined and empty secrets", async () => {
  const dir = await makeOsTempDir("harness-prompt-nosecret-");
  const promptPath = path.join(dir, "generator-attempt-1.txt");

  await writePromptFile(promptPath, "no secrets here", [undefined, ""]);

  assert.equal((await readFile(promptPath, "utf8")).trim(), "no secrets here");
});
