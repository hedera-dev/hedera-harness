import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";
import { writeProductSkillsRepo } from "./skillFixture.mjs";

const run = promisify(execFile);
const { runSession } = await import(pathToFileURL(path.resolve("dist/sessionRunner.js")).href);

/** A project whose generator always exits non-zero, so the failure recurs. */
async function makeCrashingProject() {
  const root = await makeTestTempDir("recurring-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await writeFile(path.join(root, "agent.mjs"), 'process.exit(3);\n');
  await writeFile(path.join(root, ".harness", "prd.md"), "Build the thing.\n");
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { required: ["package.json"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  const skillsRepo = await writeProductSkillsRepo(await makeTestTempDir("recurring-skills-"));

  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: recurring
maxAttempts: 2
generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(path.join(root, "agent.mjs"))}
  timeoutMs: 30000
requiredFiles:
  - built/never-written.txt
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
baseline:
  commands:
    - name: install
      command: "true"
`,
  );

  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  await run("git", ["config", "user.email", "fixture@local"], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-q", "--no-gpg-sign", "-m", "init"], { cwd: root });

  return { root, env: { HARNESS_SKILLS_REPO: skillsRepo, HARNESS_SKILLS_REF: "master" } };
}

test("a failure that recurs stays open instead of counting as fixed and new", async () => {
  // The generator crashed the same way twice. When the finding id carried the
  // attempt number the delta read "1 fixed, 1 new" for one unchanged failure,
  // which also told model escalation that the last repair had fixed something.
  const { root, env } = await makeCrashingProject();
  const previous = { ...process.env };
  Object.assign(process.env, env, { HUSKY: "0" });

  let report;
  try {
    ({ report } = await runSession({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
      skipToolChecks: true,
    }));
  } finally {
    for (const key of [...Object.keys(env), "HUSKY"]) delete process.env[key];
    Object.assign(process.env, previous);
  }

  assert.equal(report.passed, false);
  assert.equal(report.attempts, 2, "both attempts must have run");
  assert.ok(
    report.openFindingIds.includes("generator-exit"),
    `expected a stable generator-exit id, got ${report.openFindingIds.join(", ")}`,
  );
  assert.deepEqual(report.fixedFindingIds, [], "nothing was fixed, so nothing may be reported fixed");
  assert.deepEqual(
    report.openFindingIds.filter(id => /generator-(exit|timeout):\d+/.test(id)),
    [],
    "no finding id may carry the attempt number",
  );
});
