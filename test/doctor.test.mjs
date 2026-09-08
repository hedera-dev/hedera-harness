import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";
import { createServer as createHttpServer } from "node:http";
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

test("on network: local doctor probes the protocols, not just open ports", async () => {
  // An HTTP server that is not a Hedera node: it accepts connections and answers JSON, which is
  // exactly what a TCP-only probe would call healthy.
  const impostor = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hello: "not a chain" }));
  });
  await new Promise(resolve => impostor.listen(0, "127.0.0.1", resolve));
  const impostorPort = impostor.address().port;

  const root = await makeProject({
    specBody: specWith(
      "node",
      `chainValidation:
  enabled: true
  network: local
  local:
    rpcUrl: http://127.0.0.1:${impostorPort}
    grpcUrl: 127.0.0.1:${impostorPort}
    mirrorUrl: http://127.0.0.1:${impostorPort}
`,
    ),
  });

  try {
    const report = await runDoctor({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
    });

    // The port is open, so the gRPC check passes — it can only be a TCP probe.
    assert.equal(statusOf(report, "chain grpc"), "ok");
    // The other two ask the protocol a question and get the wrong answer.
    assert.equal(statusOf(report, "chain rpc"), "fail");
    assert.equal(statusOf(report, "chain mirror"), "fail");
    assert.match(formatDoctorReport(report), /not with a chain id/);
    assert.match(formatDoctorReport(report), /not like a mirror node/);
    // The operator env vars are not a local requirement, so they are not reported.
    assert.equal(statusOf(report, "HEDERA_OPERATOR_ID"), undefined);
  } finally {
    await new Promise(resolve => impostor.close(resolve));
  }
});

test("a real chain id and node list pass the local checks", async () => {
  const node = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x12a" }));
    } else {
      res.end(JSON.stringify({ nodes: [{ node_account_id: "0.0.3" }] }));
    }
  });
  await new Promise(resolve => node.listen(0, "127.0.0.1", resolve));
  const port = node.address().port;

  const root = await makeProject({
    specBody: specWith(
      "node",
      `chainValidation:
  enabled: true
  network: local
  local:
    rpcUrl: http://127.0.0.1:${port}
    grpcUrl: 127.0.0.1:${port}
    mirrorUrl: http://127.0.0.1:${port}
`,
    ),
  });

  try {
    const report = await runDoctor({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
    });
    assert.equal(statusOf(report, "chain rpc"), "ok");
    assert.equal(statusOf(report, "chain mirror"), "ok");
    assert.equal(statusOf(report, "chain grpc"), "ok");
    assert.match(formatDoctorReport(report), /chain id 298/);
  } finally {
    await new Promise(resolve => node.close(resolve));
  }
});

test("nothing listening on the local endpoints fails with a fix", async () => {
  const root = await makeProject({
    specBody: specWith(
      "node",
      `chainValidation:
  enabled: true
  network: local
  local:
    rpcUrl: http://127.0.0.1:1
    grpcUrl: 127.0.0.1:1
    mirrorUrl: http://127.0.0.1:1
`,
    ),
  });

  const report = await runDoctor({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });
  assert.equal(statusOf(report, "chain rpc"), "fail");
  assert.equal(statusOf(report, "chain grpc"), "fail");
  assert.equal(statusOf(report, "chain mirror"), "fail");
  assert.match(formatDoctorReport(report), /Start a local Hedera node/);
});
