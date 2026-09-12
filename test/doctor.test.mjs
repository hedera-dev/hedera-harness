import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const { runDoctor, formatDoctorReport } = await import(
  pathToFileURL(path.resolve("dist/doctor.js")).href
);

function statusOf(report, name) {
  return report.checks.find(check => check.name === name)?.status;
}

async function makeProject({ specBody, files = {} } = {}) {
  const root = await makeTestTempDir("doctor-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, "package.json"), '{"name":"t","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(path.join(root, rel), body);
  }
  if (specBody) await writeFile(path.join(root, ".harness", "spec.yaml"), specBody);

  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"],
    { cwd: root },
  );
  return root;
}

/**
 * Build a recipe with an explicit generator command.
 *
 * `node` rather than an agent preset: a machine without Cursor or Claude
 * installed is a legitimate environment, and these fixtures are about the
 * recipe, not the host. Built rather than concatenated so a test that wants a
 * different generator does not end up with two `generator:` keys.
 */
const specWith = (command, extra = "") =>
  `schemaVersion: 3
name: doctor-demo
generator:
  provider: command
  command: ${command}
${extra}baseline:
  commands:
    - name: install
      command: "true"
`;

const VALID_SPEC = specWith("node");

test("doctor reports a healthy project as ready", async () => {
  const root = await makeProject({ specBody: VALID_SPEC });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });

  assert.equal(statusOf(report, "node"), "ok");
  assert.equal(statusOf(report, "git"), "ok");
  assert.equal(statusOf(report, "recipe"), "ok");
  assert.equal(statusOf(report, "git repo"), "ok");
  assert.equal(statusOf(report, "prd"), "ok");
  assert.equal(report.passed, true);
  assert.match(formatDoctorReport(report), /Ready to run/);
});

test("doctor fails, rather than throws, when the recipe is missing", async () => {
  const root = await makeProject({ specBody: VALID_SPEC });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "does-not-exist.yaml"),
    workspacePath: root,
  });

  assert.equal(statusOf(report, "recipe"), "fail");
  assert.equal(report.passed, false);
  // Node and git are still reported — a broken recipe should not hide the rest.
  assert.equal(statusOf(report, "node"), "ok");
  assert.match(formatDoctorReport(report), /check\(s\) failed/);
});

test("doctor flags a recipe pointing at a file that does not exist", async () => {
  const root = await makeProject({
    specBody: specWith("node", "eval: .harness/missing.json\n"),
  });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });

  assert.equal(statusOf(report, "eval"), "fail");
  assert.equal(report.passed, false);
});

test("recipe warnings surface as warnings, not failures", async () => {
  const root = await makeProject({
    specBody: specWith("node", "programme: from-a-newer-recipe\n"),
  });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });

  assert.equal(statusOf(report, "recipe"), "warn");
  assert.equal(report.passed, true, "warnings must not fail the run");
  assert.match(formatDoctorReport(report), /warning\(s\)/);
});

test("doctor reports an unknown agent CLI as a failure", async () => {
  const root = await makeProject({
    specBody: specWith("definitely-not-a-real-binary-xyz"),
  });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });

  const agentCheck = report.checks.find(check => check.name.startsWith("agent"));
  assert.equal(agentCheck.status, "fail");
  assert.match(agentCheck.detail, /not on PATH/);
  assert.equal(report.passed, false);
});

test("doctor validates the x402 gate config before a run", async () => {
  const smoke = "server:\n  command: \"true\"\n  url: http://127.0.0.1:1\nroutes:\n  - name: home\n    path: /\n";
  const files = {
    ".harness/validators/smoke.yaml": smoke,
    ".harness/validators/x402.yaml": "routes:\n  - name: quote\n    path: /api/quote\n    maxAmount: \"1000000\"\n",
  };
  const validators = "validators:\n  playwright: .harness/validators/smoke.yaml\n  x402: .harness/validators/x402.yaml\n";

  const healthy = await makeProject({ specBody: specWith("node", validators), files });
  const report = await runDoctor({
    specPath: path.join(healthy, ".harness", "spec.yaml"),
    workspacePath: healthy,
  });
  assert.equal(statusOf(report, "x402 gate"), "ok");
  assert.match(formatDoctorReport(report), /x402 gate — 1 route\(s\) on hedera:testnet/);

  const paysWithoutSigner = await makeProject({
    specBody: specWith("node", validators),
    files: { ...files, ".harness/validators/x402.yaml": "pay: true\nroutes:\n  - name: quote\n    path: /api/quote\n" },
  });
  const noSigner = await runDoctor({
    specPath: path.join(paysWithoutSigner, ".harness", "spec.yaml"),
    workspacePath: paysWithoutSigner,
  });
  assert.equal(statusOf(noSigner, "x402 gate"), "fail");
  assert.match(formatDoctorReport(noSigner), /chainValidation is not enabled, so there is no signer/);

  const typo = await makeProject({
    specBody: specWith("node", validators),
    files: { ...files, ".harness/validators/x402.yaml": "network: base-sepolia\nroutes:\n  - name: quote\n    path: /api/quote\n" },
  });
  const broken = await runDoctor({
    specPath: path.join(typo, ".harness", "spec.yaml"),
    workspacePath: typo,
  });
  assert.equal(statusOf(broken, "x402 gate"), "fail");
  assert.match(formatDoctorReport(broken), /network must be a Hedera CAIP-2 id/);
});
