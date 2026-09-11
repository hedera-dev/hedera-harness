import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { computeInstallFingerprint } = await import(
  pathToFileURL(path.resolve("dist/validation/installFingerprint.js")).href
);

test("install fingerprint includes npm and pnpm lockfiles", async () => {
  const root = await makeTestTempDir("fingerprint-lock-");
  await writeFile(path.join(root, "package.json"), '{"name":"desk"}\n');
  const before = await computeInstallFingerprint(root);

  await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n');
  const afterNpmLock = await computeInstallFingerprint(root);
  assert.notEqual(afterNpmLock, before, "package-lock.json must change the fingerprint");

  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  const afterPnpmLock = await computeInstallFingerprint(root);
  assert.notEqual(afterPnpmLock, afterNpmLock, "pnpm-lock.yaml must change the fingerprint");
});
