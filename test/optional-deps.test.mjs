import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const optionalDeps = await import(pathToFileURL(path.resolve("dist/optionalDeps.js")).href);

test("importPlaywright succeeds when playwright is installed as a devDependency", async () => {
  const pw = await optionalDeps.importPlaywright();
  assert.equal(typeof pw.chromium.launch, "function");
});

test("importHieroSdk succeeds from the harness runtime dependency", async () => {
  const sdk = await optionalDeps.importHieroSdk();
  assert.equal(typeof sdk.PrivateKey.generateECDSA, "function");
  assert.equal(typeof sdk.Client.forTestnet, "function");
});

test("Playwright install guidance relies on the shared system Chrome fallback", () => {
  assert.deepEqual(optionalDeps.buildOptionalDepInstallLines("playwright", "npm"), [
    "npm install -D playwright",
  ]);
  assert.deepEqual(optionalDeps.buildOptionalDepInstallLines("playwright", "yarn"), [
    "yarn add -D playwright",
  ]);
  assert.deepEqual(optionalDeps.buildOptionalDepInstallLines("playwright", "pnpm"), [
    "pnpm add -D playwright",
  ]);
});

test("package.json ships the SDK and keeps playwright as an optional peer", async () => {
  const pkg = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile("package.json", "utf8")));
  // Shape, not value: pinning the exact version here means every release starts
  // with a failing test, which is how the e2e script silently rotted.
  // Prereleases (2.0.0-rc.3) are valid npm versions.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.ok(!pkg.dependencies?.playwright);
  assert.ok(pkg.dependencies?.["@hiero-ledger/sdk"]);
  assert.equal(pkg.peerDependencies.playwright, "^1.61.1");
  assert.equal(pkg.peerDependencies["@hiero-ledger/sdk"], undefined);
  assert.equal(pkg.peerDependenciesMeta.playwright.optional, true);
  assert.equal(pkg.peerDependenciesMeta["@hiero-ledger/sdk"], undefined);
  // Everything the harness reads at runtime has to be in the published tarball.
  for (const entry of ["dist", "prompts", "skeletons", "LICENSE"]) {
    assert.ok(pkg.files.includes(entry), `files should include ${entry}`);
  }
  assert.equal(pkg.bin["hedera-harness"], "./dist/index.js");
});
