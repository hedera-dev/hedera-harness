import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";

const run = promisify(execFile);
const { checkSharedPreflight } = await import(pathToFileURL(path.resolve("dist/preflight.js")).href);
const { runDoctor } = await import(pathToFileURL(path.resolve("dist/doctor.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { prepareSession } = await import(pathToFileURL(path.resolve("dist/session.js")).href);
const { runDeterministicValidation } = await import(
  pathToFileURL(path.resolve("dist/validation/index.js")).href
);
const { runValidationStages } = await import(pathToFileURL(path.resolve("dist/attemptStages.js")).href);

const byId = (verdicts, id) => verdicts.find(v => v.id === id);

async function makeProject({ specExtra = "", files = {} } = {}) {
  const root = await makeTestTempDir("recipe-shape-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# f\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(path.join(root, ".harness", "validators", "yarn.json"), "{}\n");
  await writeFile(path.join(root, "package.json"), '{"name":"t","version":"1.0.0"}\n');
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), body);
  }
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: recipe-shape
generator:
  provider: command
  command: node
${specExtra}baseline:
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
  return root;
}

async function verdictsFor(root) {
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  return checkSharedPreflight({
    workspacePath: root,
    spec: loaded.spec,
    skipIds: new Set(["evaluate-browser"]),
  });
}

// The trailing comma a hand-edited validator picks up. On dev this passed doctor
// as "present", ran the generator, then crashed ASSERT with a bare SyntaxError.
const TRAILING_COMMA = '{\n  "fileAssertions": { "required": ["hello.txt"], },\n}\n';

const SMOKE_EXTRA = "validators:\n  playwright: .harness/validators/playwright-smoke.yaml\neval: .harness/eval.json\n";
const VALID_SMOKE =
  "server:\n  command: yarn dev\n  url: http://localhost:3000\nroutes:\n  - name: home\n    path: /\n";
const VALID_FILES = {
  ".harness/validators/playwright-smoke.yaml": VALID_SMOKE,
  ".harness/eval.json": '{ "assertions": [ { "id": "E1", "statement": "loads" } ] }',
};

test("a recipe file that does not parse fails preflight before any agent runs", async () => {
  const root = await makeProject({ files: { ".harness/validators/static.json": TRAILING_COMMA } });

  const verdict = byId(await verdictsFor(root), "recipe-file:validators.static");
  assert.equal(verdict?.status, "fail");
  assert.equal(verdict?.runErrorCode, "invalid-recipe-file");
  assert.match(verdict?.detail ?? "", /^does not load: JSON: /);
  assert.doesNotMatch(verdict?.detail ?? "", /\n/, "doctor detail must be one line");
  assert.match(verdict?.runDetail ?? "", /static\.json does not load: JSON: /);

  const report = await runDoctor({ specPath: path.join(root, ".harness", "spec.yaml"), workspacePath: root });
  assert.equal(report.checks.find(check => check.name === "validators.static")?.status, "fail");
  assert.equal(report.passed, false);

  // run stops here too — before a harness branch exists, not after GENERATE.
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  await assert.rejects(
    () => prepareSession({ workspacePath: root, loaded, skipToolChecks: true, skipBaseline: true }),
    error => {
      assert.equal(error.code, "invalid-recipe-file");
      assert.match(error.message, /static\.json does not load/);
      return true;
    },
  );
  const { stdout } = await run("git", ["branch", "--show-current"], { cwd: root });
  assert.equal(stdout.trim(), "main", "no harness branch may be created for a recipe that cannot be graded");
});

test("each recipe file is checked for the shape its stage reads, and nothing stricter", async () => {
  const cases = [
    // [label, relative file, body, expected problem]
    ["validators.static", ".harness/validators/static.json", "null", "expected a JSON object"],
    ["validators.static", ".harness/validators/static.json", '{ "textAssertions": "README.md" }', "textAssertions must be an array"],
    ["validators.static", ".harness/validators/static.json", '{ "jsonAssertions": [null] }', "jsonAssertions[0] must be an object"],
    ["validators.static", ".harness/validators/static.json", '{ "jsonAssertions": [ {} ] }', "jsonAssertions[0] is missing file, path"],
    ["validators.static", ".harness/validators/static.json", '{ "textAssertions": [ { "file": "README.md" } ] }', "textAssertions[0].contains must be an array of strings"],
    ["validators.static", ".harness/validators/static.json", '{ "fileAssertions": { "required": [null] } }', "fileAssertions.required must be an array of strings"],
    ["validators.static", ".harness/validators/static.json", '{ "secretScan": { "patterns": [ { "name": "k" } ] } }', "patterns[0] is missing pattern"],
    ["validators.commands", ".harness/validators/yarn.json", '{ "commands": { "name": "install" } }', "commands must be an array"],
    ["validators.commands", ".harness/validators/yarn.json", '{ "commands": [null] }', "commands[0] must be an object"],
    ["validators.commands", ".harness/validators/yarn.json", '{ "commands": [ { "name": "install" } ] }', "commands[0] is missing command"],
    ["validators.playwright", ".harness/validators/playwright-smoke.yaml", "server: [\n", "YAML: "],
    ["validators.playwright", ".harness/validators/playwright-smoke.yaml", "routes:\n  - name: home\n    path: /\n", "server must be an object"],
    ["validators.playwright", ".harness/validators/playwright-smoke.yaml", "server:\n  command: yarn dev\n", "server is missing url"],
    ["validators.playwright", ".harness/validators/playwright-smoke.yaml", "server:\n  command: yarn dev\n  url: http://localhost:3000\n", "routes must list at least one entry"],
    ["validators.playwright", ".harness/validators/playwright-smoke.yaml", "server:\n  command: yarn dev\n  url: http://localhost:3000\nroutes:\n  - name: home\n", "routes[0] is missing path"],
    ["eval", ".harness/eval.json", '{ "assertions": { "id": "E1" } }', "assertions must be an array"],
    ["eval", ".harness/eval.json", '{ "assertions": [ { "statement": "loads" } ] }', "assertions[0] is missing id"],
  ];

  for (const [label, file, body, problem] of cases) {
    const root = await makeProject({ specExtra: SMOKE_EXTRA, files: { ...VALID_FILES, [file]: body } });
    const verdict = byId(await verdictsFor(root), `recipe-file:${label}`);
    assert.equal(verdict?.status, "fail", `${label}: ${body}`);
    assert.ok(verdict.detail.startsWith(`does not load: ${problem}`), `${label}: got ${verdict.detail}`);
  }

  // Shapes every stage accepts today stay ok: `{}` for both validators (no
  // commands is no commands), `[]` as the placeholder other tests use, and an
  // eval with an empty list.
  const root = await makeProject({
    specExtra: SMOKE_EXTRA,
    files: {
      ...VALID_FILES,
      ".harness/validators/static.json": "[]\n",
      ".harness/eval.json": '{ "assertions": [] }',
    },
  });
  const verdicts = await verdictsFor(root);
  for (const id of ["prd", "validators.static", "validators.commands", "validators.playwright", "eval"]) {
    assert.equal(byId(verdicts, `recipe-file:${id}`)?.status, "ok", id);
  }
});

test("a file that exists but cannot be read is a load failure, not a missing file", async () => {
  // A directory passes the existence check and fails the read (EISDIR), which
  // used to be reported as "missing" because both shared one catch.
  const root = await makeProject({ specExtra: "validators:\n  static: .harness/validators\n" });
  const verdict = byId(await verdictsFor(root), "recipe-file:validators.static");
  assert.equal(verdict?.status, "fail");
  assert.equal(verdict?.runErrorCode, "invalid-recipe-file");
  assert.match(verdict?.detail ?? "", /^does not load: cannot read: /);
});

test("ASSERT reports a validator file broken during GENERATE as a finding instead of throwing", async () => {
  // Preflight cannot see an edit the agent makes mid-run; ASSERT must still
  // produce a finding the repair prompt can act on, and never a crash.
  const cases = [
    [TRAILING_COMMA, '{ "commands": "yarn lint" }', /static\.json does not load: JSON: /, /yarn\.json does not load: commands must be an array/],
    ['{ "jsonAssertions": [ {} ] }', '{ "commands": [null] }', /static\.json does not load: jsonAssertions\[0\] is missing file, path/, /yarn\.json does not load: commands\[0\] must be an object/],
  ];
  for (const [staticBody, commandsBody, staticPattern, commandsPattern] of cases) {
    const root = await makeProject({
      files: { ".harness/validators/static.json": staticBody, ".harness/validators/yarn.json": commandsBody },
    });
    const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));

    const result = await runDeterministicValidation(root, loaded.spec);

    assert.equal(result.passed, false);
    const staticFinding = result.findings.find(f => f.id === "validator-file:static");
    assert.equal(staticFinding?.category, "static");
    assert.match(staticFinding?.message ?? "", staticPattern);
    const commandsFinding = result.findings.find(f => f.id === "validator-file:commands");
    assert.equal(commandsFinding?.category, "commands");
    assert.match(commandsFinding?.message ?? "", commandsPattern);
    assert.deepEqual(result.commandResults, [], "no command runs on a commands file that cannot be read");
  }

  // Deleted during GENERATE: still a finding.
  const root = await makeProject();
  await rm(path.join(root, ".harness", "validators", "static.json"));
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const result = await runDeterministicValidation(root, loaded.spec);
  assert.match(
    result.findings.find(f => f.id === "validator-file:static")?.message ?? "",
    /static\.json does not load: cannot read: /,
  );
});

test("a SMOKE config broken during GENERATE fails SMOKE as a finding and never boots the server", async () => {
  const root = await makeProject({
    specExtra: "validators:\n  playwright: .harness/validators/playwright-smoke.yaml\n",
    files: {
      // No routes; and a server command that would be noticed if it ever ran.
      ".harness/validators/playwright-smoke.yaml": "server:\n  command: sleep 30\n  url: http://127.0.0.1:1\n",
    },
  });
  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"));
  const runDirectory = path.join(root, ".harness", "runs", "test");
  await mkdir(path.join(runDirectory, "cache"), { recursive: true });
  const layout = {
    mode: "in-place-run",
    runDirectory,
    workspacePath: root,
    promptsDirectory: path.join(runDirectory, "prompts"),
    logsDirectory: path.join(runDirectory, "logs"),
    reportsDirectory: path.join(runDirectory, "reports"),
    cacheDirectory: path.join(runDirectory, "cache"),
    reportPath: path.join(runDirectory, "reports", "report.json"),
    jsonlLogPath: path.join(runDirectory, "harness.log.jsonl"),
    notesLogPath: path.join(runDirectory, "harness-notes.md"),
  };

  const startedAt = Date.now();
  const result = await runValidationStages({ attempt: 1, spec: loaded.spec, workspacePath: root, layout });

  assert.equal(result.passed, false);
  const finding = result.findings.find(f => f.id === "validator-file:playwright");
  assert.equal(finding?.category, "playwright");
  assert.match(finding?.message ?? "", /playwright-smoke\.yaml does not load: routes must list at least one entry/);
  assert.equal(result.playwrightGate, undefined, "the gate must not run on a config that does not load");
  assert.ok(Date.now() - startedAt < 10_000, "no dev-server boot may be attempted");
});
