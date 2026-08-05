import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const optionalDeps = await import(pathToFileURL(path.resolve("dist/optionalDeps.js")).href);

test("importPlaywright succeeds when playwright is installed as a devDependency", async () => {
  const pw = await optionalDeps.importPlaywright();
  assert.equal(typeof pw.chromium.launch, "function");
});

test("importHieroSdk succeeds when @hiero-ledger/sdk is installed as a devDependency", async () => {
  const sdk = await optionalDeps.importHieroSdk();
  assert.equal(typeof sdk.PrivateKey.generateECDSA, "function");
  assert.equal(typeof sdk.Client.forTestnet, "function");
});

test("package.json declares playwright and SDK as optional peers, not runtime deps", async () => {
  const pkg = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile("package.json", "utf8")));
  assert.equal(pkg.version, "1.1.1");
  assert.ok(!pkg.dependencies?.playwright);
  assert.ok(!pkg.dependencies?.["@hiero-ledger/sdk"]);
  assert.equal(pkg.peerDependencies.playwright, "^1.61.1");
  assert.equal(pkg.peerDependencies["@hiero-ledger/sdk"], "^2.86.2");
  assert.equal(pkg.peerDependenciesMeta.playwright.optional, true);
  assert.equal(pkg.peerDependenciesMeta["@hiero-ledger/sdk"].optional, true);
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("skills-index.json"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.equal(pkg.bin["hedera-harness"], "./dist/index.js");
});
