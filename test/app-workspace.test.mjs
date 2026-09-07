import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const appWorkspace = await import(pathToFileURL(path.resolve("dist/appWorkspace.js")).href);

async function writePkg(dir, name) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name }, null, 2)}\n`, "utf8");
}

test("resolveAppWorkspace keeps a scaffold app directory", async () => {
  const root = await makeTestTempDir("app-ws-app-");
  await writePkg(root, "scaffold-hbar");
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "spec.yaml"), "name: demo\n", "utf8");
  assert.equal(appWorkspace.resolveAppWorkspace(root), path.resolve(root));
});

test("resolveAppWorkspace remaps hedera-harness CLI repo to test-app", async () => {
  const cli = await makeTestTempDir("app-ws-cli-");
  await writePkg(cli, "hedera-harness");
  await mkdir(path.join(cli, "dist"), { recursive: true });
  await writeFile(path.join(cli, "dist", "index.js"), "export {};\n", "utf8");

  const app = path.join(cli, "test-app");
  await writePkg(app, "scaffold-hbar");
  await mkdir(path.join(app, ".harness", "wallet"), { recursive: true });
  await writeFile(path.join(app, ".harness", "spec.yaml"), "name: demo\n", "utf8");
  await writeFile(path.join(app, ".harness", "wallet", "metamask-test.json"), `${"x".repeat(96)}\n`, "utf8");

  assert.equal(appWorkspace.resolveAppWorkspace(cli), path.resolve(app));
  assert.equal(appWorkspace.resolveAppWorkspace(app), path.resolve(app));
  assert.equal(appWorkspace.vaultFileLooksPresent(app), true);
  assert.equal(appWorkspace.vaultFileLooksPresent(cli), false);
});

test("resolveAppWorkspace leaves an unrelated directory alone", async () => {
  const root = await makeTestTempDir("app-ws-plain-");
  assert.equal(appWorkspace.resolveAppWorkspace(root), path.resolve(root));
  assert.equal(appWorkspace.vaultFileLooksPresent(root), false);
});
