import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeTestTempDir } from "./tmpDir.mjs";

const run = promisify(execFile);
const { runSession } = await import(pathToFileURL(path.resolve("dist/sessionRunner.js")).href);
const prompts = await import(pathToFileURL(path.resolve("dist/promptBuilder.js")).href);

/**
 * A generator that writes one marker file per invocation, named after the PRD it
 * was handed. That makes the delivered order observable from the filesystem.
 */
const MOCK_AGENT = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const ws = process.env.MOCK_WS;
const prd = readFileSync(path.join(ws, ".harness/runtime/context/prd.md"), "utf8").trim();
const marker = prd.split("\\n")[0].replace(/[^a-z0-9]+/gi, "-").toLowerCase();
mkdirSync(path.join(ws, "built"), { recursive: true });
writeFileSync(path.join(ws, "built", marker + ".txt"), prd);
if (process.env.MOCK_FAIL_ON && prd.includes(process.env.MOCK_FAIL_ON)) {
  writeFileSync(path.join(ws, "built", "FAIL.txt"), "boom");
}
`;

async function makeProject(prdNames, { failOn } = {}) {
  const root = await makeTestTempDir("slices-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "agent.mjs"), MOCK_AGENT);
  await writeFile(path.join(root, "package.json"), '{"name":"x","version":"1.0.0"}\n');

  for (const name of prdNames) {
    await writeFile(path.join(root, ".harness", `${name}.md`), `${name} increment\n`);
  }
  // Forbid the failure marker so a "bad" increment fails deterministically.
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { forbidden: ["built/FAIL.txt"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: slice-demo
prd:
${prdNames.map(n => `  - .harness/${n}.md`).join("\n")}
generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(path.join(root, "agent.mjs"))}
  timeoutMs: 60000
skills: []
baseline:
  commands:
    - name: install
      command: "true"
`,
  );

  await run("git", ["init", "-q", "-b", "main", "."], { cwd: root });
  // The harness makes its own checkpoint commits with the repo's identity, and
  // a CI runner has no global one — set it locally so the fixture is a complete
  // project rather than one that only works on a developer machine.
  await run("git", ["config", "user.email", "fixture@local"], { cwd: root });
  await run("git", ["config", "user.name", "Fixture"], { cwd: root });
  await run("git", ["add", "-A"], { cwd: root });
  await run(
    "git",
    ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--no-gpg-sign", "-m", "init"],
    { cwd: root },
  );
  return { root, env: { MOCK_WS: root, ...(failOn ? { MOCK_FAIL_ON: failOn } : {}) } };
}

async function runWith(root, env) {
  const previous = { ...process.env };
  Object.assign(process.env, env, { HUSKY: "0" });
  try {
    return await runSession({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
      skipToolChecks: true,
    });
  } finally {
    for (const key of Object.keys(env)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}

test("increments are delivered in the order listed", async () => {
  const { root, env } = await makeProject(["01-foundation", "02-ui", "03-polish"]);

  const { report } = await runWith(root, env);

  assert.equal(report.passed, true);
  assert.equal(report.slices.length, 3, "one entry per increment");
  assert.deepEqual(
    report.slices.map(s => s.index),
    [0, 1, 2],
  );
  assert.ok(report.slices.every(s => s.passed));

  const built = await run("git", ["log", "--format=%s"], { cwd: root });
  const commits = built.stdout.trim().split("\n").filter(l => l.startsWith("harness:"));
  assert.ok(commits.length >= 3, `expected a checkpoint per increment, got ${commits.length}`);
});

test("a failing increment stops the sequence", async () => {
  // Later increments are written assuming earlier ones landed.
  const { root, env } = await makeProject(["01-foundation", "02-bad", "03-never"], {
    failOn: "02-bad",
  });

  const { report } = await runWith(root, env);

  assert.equal(report.passed, false);
  assert.deepEqual(
    report.slices.map(s => ({ index: s.index, passed: s.passed })),
    [
      { index: 0, passed: true },
      { index: 1, passed: false },
    ],
    "increment 3 must not run",
  );
  await assert.rejects(() => readFile(path.join(root, "built", "03-never-increment.txt")));
});

test("session records the increment it stopped on", async () => {
  const { root, env } = await makeProject(["01-a", "02-bad"], { failOn: "02-bad" });

  const { session } = await runWith(root, env);

  assert.equal(session.sliceIndex, 1, "resume should pick up at the failed increment");
});

test("a single-PRD recipe reports one slice and no increment framing", async () => {
  const { root, env } = await makeProject(["only"]);

  const { report } = await runWith(root, env);

  assert.equal(report.passed, true);
  assert.deepEqual(report.slices.map(s => s.index), [0]);

  const generatorPrompt = await readFile(
    path.join(root, "built", "only-increment.txt"),
    "utf8",
  );
  assert.match(generatorPrompt, /only increment/, "the single PRD was the one delivered");
});

test("slice framing appears only when there is more than one increment", async () => {
  const root = await makeTestTempDir("slice-prompt-");
  await writeFile(path.join(root, "prd.md"), "Do the thing.\n");
  const spec = {
    name: "demo",
    projectRoot: root,
    // One entry per increment: the runner never indexes past this list.
    prdPaths: [path.join(root, "prd.md"), path.join(root, "prd.md"), path.join(root, "prd.md")],
    requiredFiles: [],
    forbiddenFiles: [],
    validators: {},
    generator: { provider: "command", command: "agent" },
    maxAttempts: 1,
    logging: { jsonlPath: "x", notesPath: "y" },
  };

  const alone = await prompts.buildSessionPrompt(spec, 1, [], undefined, { index: 0, count: 1 });
  assert.doesNotMatch(alone, /Increment/);

  const first = await prompts.buildSessionPrompt(spec, 1, [], undefined, { index: 0, count: 3 });
  assert.match(first, /Increment 1 of 3/);
  assert.doesNotMatch(first, /already implemented/, "nothing precedes the first increment");

  const later = await prompts.buildSessionPrompt(spec, 1, [], undefined, { index: 2, count: 3 });
  assert.match(later, /Increment 3 of 3/);
  assert.match(later, /first 2 increment\(s\) are already implemented/);
});
