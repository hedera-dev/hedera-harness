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
      message: verdict.runDetail ?? verdict.detail,
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

  // Reported as `eval` config, not as a browser problem: no browser is involved,
  // and it must survive skipToolChecks the way other recipe checks do.
  const evaluate = byId(verdicts, "eval-config");
  assert.equal(evaluate?.status, "fail");
  assert.equal(evaluate?.runErrorCode, "missing-eval");
  assert.equal(evaluate?.name, "eval");
  assert.doesNotMatch(evaluate?.detail ?? "", /\n/, "doctor detail must be one line");
  assert.match(evaluate?.runDetail ?? "", /`eval` is not set/);
  assert.equal(byId(verdicts, "evaluate-browser"), undefined, "no probe without an eval path");
});

test("doctor and run agree that EVALUATE without eval is a failure", async () => {
  const root = await makeProject({ specExtra: "validator:\n  enabled: true\n" });
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });
  assert.equal(statusOf(report, "eval"), "fail");
  assert.equal(report.passed, false);

  // skipToolChecks skips host tooling, not recipe configuration — which is the
  // whole reason this verdict is not filed under the browser probe's id.
  await assert.rejects(
    () =>
      sessionMod.prepareSession({
        workspacePath: root,
        loaded,
        skipToolChecks: true,
        skipBaseline: true,
      }),
    error => {
      assert.equal(error.code, "missing-eval");
      assert.match(error.message, /`eval` is not set/);
      return true;
    },
  );
});

test("a skipped rule is never evaluated", async () => {
  const root = await makeProject({ specExtra: "validator:\n  enabled: true\neval: .harness/eval.json\n" });
  await writeFile(path.join(root, ".harness", "eval.json"), '{"assertions":[]}');
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));

  // The browser probe launches a real browser, so "skipped" has to mean not run
  // rather than run-and-discarded. Nothing else in preflight takes this long.
  const startedAt = Date.now();
  const verdicts = await checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
    skipIds: new Set(["evaluate-browser"]),
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(byId(verdicts, "evaluate-browser"), undefined);
  assert.ok(elapsed < 1000, `expected no browser probe, took ${elapsed}ms`);
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
