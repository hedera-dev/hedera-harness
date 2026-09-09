import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";

const run = promisify(execFile);
const { checkSharedPreflight } = await import(pathToFileURL(path.resolve("dist/preflight.js")).href);
const { corepackHint } = await import(pathToFileURL(path.resolve("dist/preflight.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

function byId(verdicts, id) {
  return verdicts.find(v => v.id === id);
}

test("corepackHint names the declared version and the exact command to run", () => {
  assert.match(corepackHint("yarn", "yarn@3.2.3"), /corepack enable && corepack prepare yarn@3\.2\.3 --activate/);
  assert.match(corepackHint("pnpm", "pnpm@9.1.0"), /corepack prepare pnpm@9\.1\.0 --activate/);
});

test("corepackHint falls back to @stable when no version was declared", () => {
  assert.match(corepackHint("yarn", undefined), /corepack prepare yarn@stable --activate/);
});

test("a missing yarn on PATH gets a Corepack-specific fix, not the generic message", async () => {
  const root = await makeTestTempDir("preflight-corepack-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, "package.json"), '{"name":"t","version":"1.0.0","packageManager":"yarn@3.2.3"}\n');
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: preflight-corepack-demo
generator:
  provider: command
  command: node
constraints:
  packageManager: yarn@3.2.3
baseline:
  commands:
    - name: install
      command: "true"
`,
  );
  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"],
    { cwd: root },
  );

  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));

  // Force "yarn not on PATH", deterministically, regardless of whether this
  // machine happens to have Corepack enabled — the point under test is the
  // fix message, not this environment's own setup. Keeps the standard system
  // dirs (sh, git, node) but drops anywhere a package-manager shim lives
  // (Homebrew, Volta, nvm, etc.).
  const realPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  let verdicts;
  try {
    verdicts = await checkSharedPreflight({ workspacePath: root, spec: loaded.spec });
  } finally {
    process.env.PATH = realPath;
  }

  const packageManager = byId(verdicts, "package-manager");
  assert.equal(packageManager?.status, "fail");
  assert.equal(packageManager?.runErrorCode, "missing-package-manager");
  assert.match(
    packageManager?.fix ?? "",
    /corepack enable && corepack prepare yarn@3\.2\.3 --activate/,
    `fix should give the exact Corepack command, got: ${packageManager?.fix}`,
  );
});
