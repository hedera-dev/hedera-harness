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
const { parseWaivers, applyWaivers, waiverMatches, expiredWaivers, waiveValidation } = await dist("waivers.js");
const { computeFindingDelta, applyFindingStatus, formatFindingDelta } = await dist("findingsLifecycle.js");
const { loadTemplateSpec } = await dist("specLoader.js");
const { validateWorkspace } = await dist("runner.js");
const { runDoctor } = await dist("doctor.js");
const { runSession } = await dist("sessionRunner.js");
const { buildRepairPrompt } = await dist("promptBuilder.js");

const FUTURE = "2999-12-31";
const PAST = "2020-01-01";
const finding = (id, category = "static", message = id) => ({ id, category, message });
const waiver = (finding, extra = {}) => ({ finding, reason: "accepted for the demo", expires: FUTURE, ...extra });

// ---------------------------------------------------------------- file format

test("a waiver names a finding, a reason and an end date; anything less is rejected", () => {
  const parsed = parseWaivers({
    waivers: [
      { finding: "playwright:route:home:console", reason: "Vendor analytics logs a CSP warning.", expires: "2026-10-01", by: "divyesh" },
      { finding: "static-required:docs/*", reason: "Docs land in the next increment.", expires: new Date("2026-10-15T00:00:00Z") },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    finding: "playwright:route:home:console",
    reason: "Vendor analytics logs a CSP warning.",
    expires: "2026-10-01",
    by: "divyesh",
  });
  assert.equal(parsed[1].expires, "2026-10-15", "YAML may hand the date over as a Date");

  assert.deepEqual(parseWaivers({}), []);
  assert.throws(() => parseWaivers({ waivers: [{ finding: "x", expires: FUTURE }] }), /waivers\[0\]\.reason must be a non-empty string/);
  assert.throws(() => parseWaivers({ waivers: [{ finding: "x", reason: "r" }] }), /expires must be a date \(YYYY-MM-DD\)/);
  assert.throws(() => parseWaivers({ waivers: [{ finding: "x", reason: "r", expires: "next month" }] }), /expires must be a date/);
  assert.throws(() => parseWaivers({ waivers: [{ finding: "x", reason: "r", expires: FUTURE, reasn: "typo" }] }), /unknown key "reasn"/);
  assert.throws(() => parseWaivers({ waivers: "nope" }), /"waivers" must be a list/);
  assert.throws(() => parseWaivers([]), /expected a mapping/);
});

test("a waiver can never reach a secret finding, and a leading wildcard is refused", () => {
  assert.throws(() => parseWaivers({ waivers: [waiver("secret-file:.env")] }), /secret findings cannot be waived/);
  assert.throws(() => parseWaivers({ waivers: [waiver("secret-pattern:*")] }), /secret findings cannot be waived/);
  assert.throws(() => parseWaivers({ waivers: [waiver("*")] }), /leading wildcard would waive every gate/);
  assert.throws(() => parseWaivers({ waivers: [waiver("*:console")] }), /leading wildcard/);
  // A pattern that slips past the prefix rule is still stopped at apply time.
  const applied = applyWaivers(
    [finding("secret-pattern:private-key-assignment:.env.local", "secret"), finding("static-required:README.md")],
    [waiver("s*")],
  );
  assert.deepEqual(applied.waivedIds, ["static-required:README.md"]);
  assert.deepEqual(applied.refused.map(f => f.id), ["secret-pattern:private-key-assignment:.env.local"]);
  assert.equal(applied.findings[0].status, undefined);
});

test("patterns match exactly or by prefix wildcard", () => {
  assert.equal(waiverMatches("a:b", "a:b"), true);
  assert.equal(waiverMatches("a:b", "a:bc"), false);
  assert.equal(waiverMatches("playwright:route:*:console", "playwright:route:home:console"), true);
  assert.equal(waiverMatches("playwright:route:*:console", "playwright:route:home:render"), false);
  assert.equal(waiverMatches("json:package.json:*", "json:package.json:name"), true);
  assert.equal(waiverMatches("text:a.md:needle (x)", "text:a.md:needle (x)"), true, "regex characters are literal");
  assert.equal(waiverMatches("json:*:name", "json:a:b:name"), true);
  assert.equal(waiverMatches("json:*:name", "json:a:b:names"), false);
  assert.equal(waiverMatches("a*", "a"), true);
  assert.equal(waiverMatches("a**b", "axxb"), true);

  // The pattern is user input from a file; matching must stay linear-ish even
  // when someone writes a wildcard between every character against a long id.
  const hostile = `x:${"*a".repeat(40)}*`;
  const longId = `x:${"a".repeat(2000)}b`;
  const started = Date.now();
  assert.equal(waiverMatches(hostile, longId), true);
  assert.equal(waiverMatches(`${hostile}c`, longId), false);
  assert.ok(Date.now() - started < 500, "no catastrophic backtracking");
});

// ---------------------------------------------------------------- applying

test("matching findings become waived; expired waivers, fixed findings and agent findings are left alone", () => {
  const findings = [
    finding("static-required:README.md"),
    finding("command:build", "commands"),
    { ...finding("json:package.json:name"), status: "fixed" },
    finding("generator-exit", "agent"),
  ];
  const applied = applyWaivers(findings, [
    waiver("static-required:*"),
    waiver("command:build", { expires: PAST }),
    waiver("json:package.json:name"),
    waiver("generator-exit"),
  ], new Date("2026-09-13T12:00:00Z"));

  assert.deepEqual(applied.waivedIds, ["static-required:README.md"]);
  assert.equal(applied.findings[0].status, "waived");
  assert.equal(applied.findings[0].waiver.finding, "static-required:*");
  assert.equal(applied.findings[1].status, undefined, "an expired waiver matches nothing");
  assert.equal(applied.findings[2].status, "fixed");
  assert.deepEqual(applied.refused.map(f => f.id), ["generator-exit"]);
});

test("a waiver is valid through its end date", () => {
  const w = waiver("x", { expires: "2026-09-13" });
  assert.deepEqual(expiredWaivers([w], new Date("2026-09-13T23:59:00Z")), []);
  assert.deepEqual(expiredWaivers([w], new Date("2026-09-14T00:00:01Z")), [w]);
});

test("waiveValidation recomputes passed from what is still blocking", () => {
  const failing = { passed: false, findings: [finding("static-required:README.md"), finding("generator-exit", "agent")], commandResults: [] };
  assert.equal(waiveValidation(failing, [waiver("static-required:README.md")]).passed, true);
  assert.equal(waiveValidation(failing, [waiver("something-else")]).passed, false);
  assert.equal(waiveValidation(failing, []), failing, "no waivers, nothing touched");
});

// ---------------------------------------------------------------- lifecycle

test("the finding delta keeps waived ids out of open and never counts them as fixed", () => {
  const current = applyWaivers([finding("a"), finding("b"), finding("c")], [waiver("b")]).findings;
  const delta = computeFindingDelta(["a", "b"], current);
  assert.deepEqual(delta.open, ["a", "c"]);
  assert.deepEqual(delta.fixed, [], "b was accepted, not repaired");
  assert.deepEqual(delta.introduced, ["c"]);
  assert.deepEqual(delta.waived, ["b"]);
  assert.equal(formatFindingDelta(delta), "2 open, 1 new, 1 waived");
  assert.equal(formatFindingDelta({ open: [], fixed: [], introduced: [], waived: ["b"] }), "no findings, 1 waived");

  const stamped = applyFindingStatus(current, delta, []);
  assert.deepEqual(stamped.map(f => f.status), ["open", "waived", "open"]);
});

test("waived findings are never written into the repair prompt", async () => {
  const spec = {
    projectRoot: process.cwd(),
    prdPaths: [path.resolve(".harness/prd.md")],
    requiredFiles: [],
    constraints: { forbiddenCommands: [] },
  };
  const findings = applyWaivers(
    [finding("static-required:README.md", "static", "Static validator requires file: README.md"), finding("command:build", "commands", "Validation command failed: build")],
    [waiver("static-required:README.md")],
  ).findings;
  const prompt = await buildRepairPrompt(spec, findings, 2);
  assert.match(prompt, /Validation command failed: build/);
  assert.doesNotMatch(prompt, /requires file: README\.md/);
});

// ---------------------------------------------------------------- recipe, validate, doctor, run

async function makeProject({ waivers, agent = false, git = false, prefix = "waivers-" } = {}) {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# Remove the leftover build marker\n");
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { forbidden: ["built/FAIL.txt"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  if (waivers !== undefined) await writeFile(path.join(root, ".harness", "waivers.yaml"), waivers);
  let generator = "generator:\n  provider: command\n  command: node\n";
  if (agent) {
    await writeFile(
      path.join(root, "agent.mjs"),
      'import { writeFileSync, mkdirSync } from "node:fs"; mkdirSync("built", { recursive: true }); writeFileSync("built/FAIL.txt", "still broken\\n");\n',
    );
    generator = `generator:\n  provider: command\n  command: node\n  args:\n    - ${JSON.stringify(path.join(root, "agent.mjs"))}\n`;
  }
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: waivers-demo
maxAttempts: 2
${generator}${waivers !== undefined ? "waivers: .harness/waivers.yaml\n" : ""}baseline:
  commands:
    - name: install
      command: "true"
`,
  );
  if (git) {
    await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"], { cwd: root });
  }
  return { root, specPath: path.join(root, ".harness", "spec.yaml") };
}

const ACCEPTED = `waivers:
  - finding: static-forbidden:built/FAIL.txt
    reason: The build marker is removed by the deploy step, not by the app.
    expires: ${FUTURE}
    by: divyesh
`;
const EXPIRED = ACCEPTED.replace(FUTURE, PAST);

test("`waivers:` resolves against the project root and is a known key", async () => {
  const { specPath } = await makeProject({ waivers: ACCEPTED });
  const { spec, warnings } = await loadTemplateSpec(specPath);
  assert.match(spec.waiversPath, /\.harness\/waivers\.yaml$/);
  assert.deepEqual(warnings.filter(w => w.includes("unknown key")), []);

  const none = await makeProject();
  assert.equal((await loadTemplateSpec(none.specPath)).spec.waiversPath, undefined);
});

test("validate reports a waived finding without failing on it", async () => {
  const { root, specPath } = await makeProject({ waivers: ACCEPTED });
  await mkdir(path.join(root, "built"), { recursive: true });
  await writeFile(path.join(root, "built", "FAIL.txt"), "still broken\n");

  const validation = await validateWorkspace({ specPath, workspacePath: root });
  assert.equal(validation.passed, true);
  assert.equal(validation.findings.length, 1);
  assert.equal(validation.findings[0].id, "static-forbidden:built/FAIL.txt");
  assert.equal(validation.findings[0].status, "waived");
  assert.equal(validation.findings[0].waiver.by, "divyesh");

  const expired = await makeProject({ waivers: EXPIRED });
  await mkdir(path.join(expired.root, "built"), { recursive: true });
  await writeFile(path.join(expired.root, "built", "FAIL.txt"), "still broken\n");
  const enforced = await validateWorkspace({ specPath: expired.specPath, workspacePath: expired.root });
  assert.equal(enforced.passed, false);
  assert.equal(enforced.findings[0].status, undefined);
});

test("doctor reports accepted findings, warns when one has expired, fails on a broken file", async () => {
  const statusOf = (report, name) => report.checks.find(c => c.name === name);

  const ok = await makeProject({ waivers: ACCEPTED, git: true, prefix: "waivers-doctor-" });
  const okReport = await runDoctor({ specPath: ok.specPath, workspacePath: ok.root });
  assert.equal(statusOf(okReport, "waivers").status, "ok", "the recipe file is present");
  assert.equal(statusOf(okReport, "accepted findings").status, "ok");
  assert.match(statusOf(okReport, "accepted findings").detail, /1 accepted finding\(s\), none expired/);

  const expired = await makeProject({ waivers: EXPIRED, git: true, prefix: "waivers-doctor-" });
  const expiredReport = await runDoctor({ specPath: expired.specPath, workspacePath: expired.root });
  assert.equal(statusOf(expiredReport, "accepted findings").status, "warn");
  assert.match(statusOf(expiredReport, "accepted findings").fix, /enforced again/);
  assert.equal(expiredReport.passed, true, "a warning does not block a run");

  const broken = await makeProject({ waivers: "waivers:\n  - finding: secret-file:.env\n    reason: no\n    expires: 2999-01-01\n", git: true, prefix: "waivers-doctor-" });
  const brokenReport = await runDoctor({ specPath: broken.specPath, workspacePath: broken.root });
  assert.equal(statusOf(brokenReport, "accepted findings").status, "fail");
  assert.match(statusOf(brokenReport, "accepted findings").detail, /secret findings cannot be waived/);

  const missing = await makeProject({ waivers: ACCEPTED, git: true, prefix: "waivers-doctor-" });
  await run("rm", [path.join(missing.root, ".harness", "waivers.yaml")]);
  const missingReport = await runDoctor({ specPath: missing.specPath, workspacePath: missing.root });
  assert.equal(statusOf(missingReport, "waivers").status, "fail");
  assert.equal(statusOf(missingReport, "accepted findings"), undefined, "no second failure for the same cause");

  const none = await makeProject({ git: true, prefix: "waivers-doctor-" });
  const noneReport = await runDoctor({ specPath: none.specPath, workspacePath: none.root });
  assert.equal(statusOf(noneReport, "accepted findings"), undefined);
});

async function runProject({ waivers }) {
  const { root, specPath } = await makeProject({ waivers, agent: true, git: true, prefix: "waivers-run-" });
  const skillsRepo = await writeProductSkillsRepo(await makeTestTempDir("waivers-skills-"));
  const env = { HARNESS_SKILLS_REPO: skillsRepo, HARNESS_SKILLS_REF: "master", HUSKY: "0" };
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { report, outroLines } = await runSession({ specPath, workspacePath: root, skipToolChecks: true });
    const events = (await readFile(path.join(root, ".harness", "runs", "harness.log.jsonl"), "utf8"))
      .split("\n").filter(Boolean).map(line => JSON.parse(line));
    return { report, outroLines, events, root };
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("a waived finding does not cost a repair attempt, and is still visible in the report", async () => {
  // The mock agent leaves built/FAIL.txt behind every time. With the finding
  // accepted, the run passes on the first attempt; the finding is reported as
  // waived rather than open or fixed, and the agent is never asked to repair it.
  const { report, outroLines, events } = await runProject({ waivers: ACCEPTED });

  assert.equal(report.passed, true);
  assert.equal(report.attempts, 1, "no second attempt for a finding a person accepted");
  assert.deepEqual(report.openFindingIds, []);
  assert.deepEqual(report.fixedFindingIds, []);
  assert.deepEqual(report.waivedFindingIds, ["static-forbidden:built/FAIL.txt"]);
  const waived = report.validation.findings.find(f => f.id === "static-forbidden:built/FAIL.txt");
  assert.equal(waived.status, "waived");
  assert.match(waived.waiver.reason, /deploy step/);

  const finished = events.find(e => e.type === "validation_finished");
  assert.deepEqual(finished.waivedFindingIds, ["static-forbidden:built/FAIL.txt"]);
  assert.equal(events.some(e => e.type === "repair_started"), false);

  const outro = outroLines.join("\n");
  assert.match(outro, /Run PASSED/);
  assert.match(outro, /Waived, still present \(1\):/);
  assert.match(outro, /static-forbidden:built\/FAIL\.txt: The build marker/);
});

test("an expired waiver enforces the finding again", async () => {
  const { report } = await runProject({ waivers: EXPIRED });
  assert.equal(report.passed, false);
  assert.equal(report.attempts, 2);
  assert.deepEqual(report.openFindingIds, ["static-forbidden:built/FAIL.txt"]);
  assert.deepEqual(report.waivedFindingIds, []);
});
