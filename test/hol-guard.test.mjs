import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";
import { writeProductSkillsRepo } from "./skillFixture.mjs";

const run = promisify(execFile);
const dist = name => import(pathToFileURL(path.resolve(`dist/${name}`)).href);
const { loadTemplateSpec } = await dist("specLoader.js");
const { runDeterministicValidation } = await dist("validation/index.js");
const { buildHolGuardFindings, parseHolGuardReport, holGuardScanCommand } = await dist(
  "validation/holGuard.js",
);
const { computeFindingDelta } = await dist("findingsLifecycle.js");
const { classifyRepairScope } = await dist("promptBuilder.js");
const { runDoctor } = await dist("doctor.js");
const { runSession } = await dist("sessionRunner.js");

const FIXTURES = path.resolve("test/fixtures/hol-guard");
const STUB = path.join(FIXTURES, "scanner.mjs");
/** `validators.holGuard.command` that prints a captured report instead of scanning. */
const stubCommand = fixture => `${JSON.stringify(process.execPath)} ${JSON.stringify(STUB)} ${fixture}`;
const MISSING_BINARY = "hol-guard-binary-that-does-not-exist-9f3a";

const holGuardBlock = (command, extra = "") => `validators:
  holGuard:
    enabled: true
    command: ${JSON.stringify(command)}
${extra}`;

/** A project with the files the loader and ASSERT expect, plus the given recipe body. */
async function makeProject(specBody, { prefix = "hol-guard-", git = false, generatorArgs = [] } = {}) {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# feature\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "{}\n");
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: hol-guard-demo
generator:
  provider: command
  command: node
${generatorArgs.map(arg => `  args:\n    - ${JSON.stringify(arg)}\n`).join("")}${specBody}baseline:
  commands:
    - name: install
      command: "true"
`,
  );
  if (git) {
    await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
    await run("git", ["add", "-A"], { cwd: root });
    await run(
      "git",
      ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"],
      { cwd: root },
    );
  }
  return { root, specPath: path.join(root, ".harness", "spec.yaml") };
}

async function assertWith(specBody) {
  const { root, specPath } = await makeProject(specBody);
  const { spec } = await loadTemplateSpec(specPath);
  return runDeterministicValidation(root, spec);
}

const securityIds = validation =>
  validation.findings.filter(f => f.category === "security").map(f => f.id);

// ---------------------------------------------------------------- recipe

test("validators.holGuard is off unless enabled: true, and loads with defaults", async () => {
  const off = await makeProject("");
  assert.equal((await loadTemplateSpec(off.specPath)).spec.validators.holGuard, undefined);

  const disabled = await makeProject("validators:\n  holGuard:\n    enabled: false\n");
  assert.equal((await loadTemplateSpec(disabled.specPath)).spec.validators.holGuard, undefined);

  const on = await makeProject("validators:\n  holGuard:\n    enabled: true\n");
  const { spec, warnings } = await loadTemplateSpec(on.specPath);
  assert.deepEqual(spec.validators.holGuard, {
    enabled: true,
    command: "uvx --from hol-guard plugin-scanner",
    failOnSeverity: "high",
    profile: undefined,
    timeoutMs: 240_000,
  });
  assert.equal(holGuardScanCommand(spec.validators.holGuard), "uvx --from hol-guard plugin-scanner scan . --format json");
  assert.deepEqual(warnings.filter(w => w.includes("unknown key")), []);
});

test("failOnSeverity and profile are checked at load, and info can never be the threshold", async () => {
  const bad = await makeProject("validators:\n  holGuard:\n    enabled: true\n    failOnSeverity: info\n");
  await assert.rejects(loadTemplateSpec(bad.specPath), /failOnSeverity must be one of critical, high, medium, low/);

  const profile = await makeProject("validators:\n  holGuard:\n    enabled: true\n    profile: paranoid\n");
  await assert.rejects(loadTemplateSpec(profile.specPath), /profile must be one of default, public-marketplace, strict-security/);

  const strict = await makeProject(
    "validators:\n  holGuard:\n    enabled: true\n    failOnSeverity: low\n    profile: strict-security\n",
  );
  const { spec } = await loadTemplateSpec(strict.specPath);
  assert.equal(spec.validators.holGuard.failOnSeverity, "low");
  assert.equal(
    holGuardScanCommand(spec.validators.holGuard),
    "uvx --from hol-guard plugin-scanner scan . --format json --profile strict-security",
  );
});

// ---------------------------------------------------------------- conversion

test("findings at or above the threshold become [security] findings with stable ids", async () => {
  const report = parseHolGuardReport(await readFile(path.join(FIXTURES, "findings.json"), "utf8"));
  assert.ok(report);

  const high = buildHolGuardFindings(report, { failOnSeverity: "high" });
  assert.equal(high.total, 5);
  assert.deepEqual(
    high.findings.map(f => f.id),
    [
      "hol-guard:MCP_SERVER_UNPINNED_REMOTE:.mcp.json:7",
      "hol-guard:SKILL_SHELL_WITHOUT_ALLOWLIST:skills/deploy/SKILL.md:3",
    ],
  );
  assert.equal(high.findings[0].category, "security");
  assert.equal(
    high.findings[0].message,
    "[HIGH] MCP_SERVER_UNPINNED_REMOTE: MCP server is fetched from an unpinned remote (.mcp.json:7)",
  );
  assert.match(high.findings[0].details, /^The MCP server command runs/);
  assert.match(high.findings[0].details, /Remediation: Pin the package/);

  // Lowering the threshold adds the medium and low entries; info never fails.
  const low = buildHolGuardFindings(report, { failOnSeverity: "low" });
  assert.deepEqual(
    low.findings.map(f => f.id),
    [
      "hol-guard:CODEXIGNORE_MISSING",
      "hol-guard:MCP_SERVER_UNPINNED_REMOTE:.mcp.json:7",
      "hol-guard:PLUGIN_MANIFEST_MISSING_LICENSE:.claude-plugin/plugin.json",
      "hol-guard:SKILL_SHELL_WITHOUT_ALLOWLIST:skills/deploy/SKILL.md:3",
    ],
  );
});

test("the report is found even when uvx or the scanner print around it", () => {
  const body = JSON.stringify({ findings: [], score: 100 });
  assert.ok(parseHolGuardReport(`Installed 12 packages in 1.2s\n${body}\nhint: rerun with --strict\n`));
  assert.equal(parseHolGuardReport("Installed 12 packages in 1.2s\n"), null);
  assert.equal(parseHolGuardReport(JSON.stringify({ score: 100 })), null, "a payload without findings[] is not a report");
});

// ---------------------------------------------------------------- ASSERT

test("findings above the threshold fail ASSERT; the same scan twice is one open finding, not fixed and new", async () => {
  const first = await assertWith(holGuardBlock(stubCommand("findings.json")));
  assert.equal(first.passed, false);
  assert.equal(first.infrastructureFailure, undefined);
  assert.deepEqual(securityIds(first), [
    "hol-guard:MCP_SERVER_UNPINNED_REMOTE:.mcp.json:7",
    "hol-guard:SKILL_SHELL_WITHOUT_ALLOWLIST:skills/deploy/SKILL.md:3",
  ]);
  assert.equal(first.holGuard.blockingTotal, 2);
  assert.equal(first.holGuard.findingsTotal, 5);
  assert.equal(first.holGuard.grade, "D");

  const second = await assertWith(holGuardBlock(stubCommand("findings.json")));
  const delta = computeFindingDelta(securityIds(first), second.findings);
  assert.deepEqual(delta.fixed, []);
  assert.deepEqual(delta.introduced, []);
  assert.equal(delta.open.length, 2);
});

test("findings below the threshold pass ASSERT, and a recipe without the block is untouched", async () => {
  const medium = await assertWith(holGuardBlock(stubCommand("findings.json"), "    failOnSeverity: critical\n"));
  assert.equal(medium.passed, true);
  assert.deepEqual(securityIds(medium), []);
  assert.equal(medium.holGuard.blockingTotal, 0);
  assert.equal(medium.holGuard.findingsTotal, 5);

  const clean = await assertWith(holGuardBlock(stubCommand("clean.json")));
  assert.equal(clean.passed, true);
  assert.equal(clean.holGuard.grade, "A");

  const off = await assertWith("");
  assert.equal(off.passed, true);
  assert.deepEqual(Object.keys(off).sort(), ["commandResults", "findings", "passed"]);
});

test("a scanner that prints no report aborts ASSERT as infrastructure, not as an app finding", async () => {
  const malformed = await assertWith(holGuardBlock(stubCommand("malformed.txt")));
  assert.equal(malformed.passed, false);
  assert.equal(malformed.infrastructureFailure, true);
  assert.match(malformed.infrastructureFailureReason, /did not produce a JSON report/);
  assert.match(malformed.infrastructureFailureReason, /unrecognized arguments/);
  assert.deepEqual(malformed.findings, []);
  assert.equal(malformed.holGuard, undefined);

  const crashed = await assertWith(holGuardBlock(stubCommand("crash")));
  assert.equal(crashed.infrastructureFailure, true);
  assert.match(crashed.infrastructureFailureReason, /exit 2/);
  assert.match(crashed.infrastructureFailureReason, /ModuleNotFoundError/);
});

test("a missing scanner binary aborts ASSERT as infrastructure", async () => {
  const missing = await assertWith(holGuardBlock(MISSING_BINARY));
  assert.equal(missing.passed, false);
  assert.equal(missing.infrastructureFailure, true);
  assert.match(missing.infrastructureFailureReason, /not installed/);
  assert.match(missing.infrastructureFailureReason, /exited 127/);
  assert.deepEqual(missing.findings, []);
});

test("[security] findings take the broad repair scope", () => {
  const security = { id: "hol-guard:X:a.json:1", category: "security", message: "x" };
  assert.equal(classifyRepairScope([security]), "broad");
  assert.equal(
    classifyRepairScope([security, { id: "command:build", category: "commands", message: "y" }]),
    "broad",
  );
});

// ---------------------------------------------------------------- attempt loop

test("an ASSERT infrastructure failure leaves the attempt loop through the abort path", async () => {
  // The scanner is missing on this machine. GENERATE was already paid for once;
  // the loop must stop there, abort like an EVALUATE infra failure, and neither
  // throw nor spend the second attempt asking the agent to install the scanner.
  const agentScript = path.join(await makeTestTempDir("hol-guard-agent-"), "agent.mjs");
  await writeFile(agentScript, "process.exit(0);\n");
  const { root, specPath } = await makeProject(
    `maxAttempts: 2\n${holGuardBlock(MISSING_BINARY)}`,
    { prefix: "hol-guard-loop-", git: true, generatorArgs: [agentScript] },
  );
  const skillsRepo = await writeProductSkillsRepo(await makeTestTempDir("hol-guard-skills-"));
  const env = { HARNESS_SKILLS_REPO: skillsRepo, HARNESS_SKILLS_REF: "master", HUSKY: "0" };
  const previous = { ...process.env };
  Object.assign(process.env, env);

  let report;
  try {
    ({ report } = await runSession({ specPath, workspacePath: root, skipToolChecks: true }));
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, previous);
  }

  assert.equal(report.passed, false);
  assert.equal(report.attempts, 1, "no repair attempt is spent on a scanner the agent cannot install");
  assert.equal(report.validation.infrastructureFailure, true);
  assert.match(report.validation.infrastructureFailureReason, /not installed/);
  assert.deepEqual(report.openFindingIds, []);

  const events = (await readFile(path.join(root, ".harness", "runs", "harness.log.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  const aborted = events.find(event => event.type === "validator_infra_aborted");
  assert.ok(aborted, "the abort is logged");
  assert.equal(aborted.stage, "ASSERT");
  assert.match(aborted.reason, /exited 127/);
});

// ---------------------------------------------------------------- doctor

test("doctor checks the scanner only when the recipe enables it", async () => {
  const off = await makeProject("", { prefix: "hol-guard-doctor-", git: true });
  const offReport = await runDoctor({ specPath: off.specPath, workspacePath: off.root });
  assert.equal(offReport.checks.find(c => c.name === "HOL Guard scanner"), undefined);

  const ok = await makeProject(holGuardBlock(stubCommand("clean.json")), { prefix: "hol-guard-doctor-", git: true });
  const okReport = await runDoctor({ specPath: ok.specPath, workspacePath: ok.root });
  const check = okReport.checks.find(c => c.name === "HOL Guard scanner");
  assert.equal(check.status, "ok");
  assert.match(check.detail, /answers --help; findings at high\+ fail ASSERT/);

  const missing = await makeProject(holGuardBlock(MISSING_BINARY), { prefix: "hol-guard-doctor-", git: true });
  const missingReport = await runDoctor({ specPath: missing.specPath, workspacePath: missing.root });
  const failed = missingReport.checks.find(c => c.name === "HOL Guard scanner");
  assert.equal(failed.status, "fail");
  assert.equal(failed.detail, `${MISSING_BINARY} is not on PATH`);
  assert.match(failed.fix, /Install uv/);
  assert.equal(missingReport.passed, false);
});
