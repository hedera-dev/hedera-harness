import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";

const run = promisify(execFile);
const { checkSharedPreflight, SKIPPABLE_HOST_PREFLIGHT_IDS } = await import(
  pathToFileURL(path.resolve("dist/preflight.js")).href
);
const { runDoctor } = await import(pathToFileURL(path.resolve("dist/doctor.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const sessionMod = await import(pathToFileURL(path.resolve("dist/session.js")).href);

function byId(verdicts, id) {
  return verdicts.find(v => v.id === id);
}

function statusOf(report, name) {
  return report.checks.find(check => check.name === name)?.status;
}

/** Thin session-style assert: first fail → { code, message }, mirroring prepareSession. */
function firstFailure(verdicts, { skipHostTooling = false } = {}) {
  for (const verdict of verdicts) {
    if (skipHostTooling && SKIPPABLE_HOST_PREFLIGHT_IDS.has(verdict.id)) continue;
    if (verdict.status !== "fail") continue;
    return {
      code: verdict.runErrorCode ?? "preflight-failed",
      message: verdict.detail,
    };
  }
  return null;
}

async function makeProject({ specExtra = "", files = {} } = {}) {
  const root = await makeTestTempDir("preflight-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, "package.json"), '{"name":"t","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }

  const specBody = `schemaVersion: 3
name: preflight-demo
generator:
  provider: command
  command: node
${specExtra}baseline:
  commands:
    - name: install
      command: "true"
`;
  await writeFile(path.join(root, ".harness", "spec.yaml"), specBody);

  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"],
    { cwd: root },
  );
  return root;
}

test("shared preflight reports ok for node, git, agent, and recipe paths", async () => {
  const root = await makeProject();
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const verdicts = await checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
  });

  assert.equal(byId(verdicts, "node")?.status, "ok");
  assert.equal(byId(verdicts, "git")?.status, "ok");
  assert.equal(byId(verdicts, "git-repo")?.status, "ok");
  assert.equal(byId(verdicts, "agent")?.status, "ok");
  assert.equal(byId(verdicts, "package-manager")?.status, "ok");
  assert.equal(byId(verdicts, "recipe-file:prd")?.status, "ok");
  assert.equal(byId(verdicts, "recipe-file:validators.static")?.status, "ok");
  assert.equal(byId(verdicts, "recipe-file:validators.commands")?.status, "ok");
  assert.equal(firstFailure(verdicts), null);
});

test("shared preflight fails missing agent with missing-agent code", async () => {
  const root = await makeProject();
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: preflight-demo
generator:
  provider: command
  command: definitely-not-a-real-binary-xyz
baseline:
  commands:
    - name: install
      command: "true"
`,
  );
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "agent"],
    { cwd: root },
  );

  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const verdicts = await checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
  });

  const agent = byId(verdicts, "agent");
  assert.equal(agent?.status, "fail");
  assert.equal(agent?.runErrorCode, "missing-agent");
  assert.equal(firstFailure(verdicts)?.code, "missing-agent");
});

test("EVALUATE enabled without eval fails with missing-eval", async () => {
  const root = await makeProject({
    specExtra: "validator:\n  enabled: true\n",
  });
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const verdicts = await checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
  });

  const evaluate = byId(verdicts, "evaluate-browser");
  assert.equal(evaluate?.status, "fail");
  assert.equal(evaluate?.runErrorCode, "missing-eval");
  assert.match(evaluate?.detail ?? "", /`eval` is not set/);
});

test("doctor and session-style assert agree on a missing recipe file", async () => {
  const root = await makeProject({
    specExtra: "eval: .harness/missing-eval.json\n",
  });

  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const verdicts = await checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
  });

  const fileFail = byId(verdicts, "recipe-file:eval");
  assert.equal(fileFail?.status, "fail");
  assert.equal(fileFail?.runErrorCode, "missing-recipe-file");

  const sessionStyle = firstFailure(verdicts);
  assert.equal(sessionStyle?.code, "missing-recipe-file");
  assert.match(sessionStyle?.message ?? "", /missing-eval\.json/);

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });
  assert.equal(statusOf(report, "eval"), "fail");
  assert.equal(report.passed, false);

  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "missing-recipe-file");
      assert.match(error.message, /missing-eval\.json/);
      return true;
    },
  );
});
