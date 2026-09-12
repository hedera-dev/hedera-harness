import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";
import { writeProductSkillsRepo } from "./skillFixture.mjs";

const run = promisify(execFile);
const { runSession } = await import(pathToFileURL(path.resolve("dist/sessionRunner.js")).href);

/** A build that chatters, warns on stderr, and says why on stdout at the very end. */
const NOISY_BUILD = `
for (let i = 0; i < 200; i++) console.log("info  - compiling module " + i + " ..........................");
console.error("warning: peer dependency drift (harmless)");
console.log("ERROR_MARKER: Type error in app/page.tsx line 12: Property 'foo' does not exist.");
process.exit(1);
`;

async function makeProject() {
  const root = await makeTestTempDir("failure-details-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');
  await writeFile(path.join(root, "noisy-build.mjs"), NOISY_BUILD);
  await writeFile(path.join(root, "agent.mjs"), 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("built", { recursive: true });\nwriteFileSync("built/feature.txt", "done");\n');
  await writeFile(path.join(root, ".harness", "prd.md"), "Build the thing.\n");
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { required: ["package.json"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({
      commands: [
        { name: "install", command: "true" },
        { name: "build", command: "node noisy-build.mjs", timeoutMs: 30000 },
      ],
    }),
  );
  const skillsRepo = await writeProductSkillsRepo(await makeTestTempDir("failure-details-skills-"));

  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: failure-details
maxAttempts: 1
generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(path.join(root, "agent.mjs"))}
  timeoutMs: 30000
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

test("a failing command reports why, not just the noise before it", async () => {
  // The repair prompt is built from these details. Before this the agent was
  // handed a harmless stderr warning while the type error on stdout was
  // dropped, so every repair attempt that followed was blind.
  const { root, env } = await makeProject();
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
  const validation = JSON.parse(
    await readFile(path.join(report.runDirectory, "logs", "validation-attempt-1.json"), "utf8"),
  );
  const build = validation.findings.find(finding => finding.id === "command:build");
  assert.ok(build, `expected a build finding, got ${validation.findings.map(f => f.id).join(", ")}`);
  assert.ok(
    build.details.includes("ERROR_MARKER"),
    `the reason must reach the agent; details were:\n${build.details}`,
  );
  assert.ok(
    build.details.includes("peer dependency drift"),
    "the stderr warning is still useful context",
  );
});
