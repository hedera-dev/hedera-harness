import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const prompts = await import(pathToFileURL(path.resolve("dist/promptBuilder.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { EXTEND_CONTEXT_DIR, EXTEND_SKILLS_DIR } = await import(
  pathToFileURL(path.resolve("dist/runtimePaths.js")).href
);
const { shouldIgnoreWorkspaceActivity } = await import(
  pathToFileURL(path.resolve("dist/workspaceWatcher.js")).href
);

test("parseCliArgs accepts extend with max-attempts and defaults workspace to unset (cwd)", () => {
  const parsed = cli.parseCliArgs(["extend", ".harness/spec.yaml", "--max-attempts", "3"]);
  assert.equal(parsed.command, "extend");
  assert.equal(parsed.options.specPath, ".harness/spec.yaml");
  assert.equal(parsed.options.maxAttempts, 3);
  assert.equal(parsed.options.workspacePath, undefined);
  assert.equal(parsed.options.continueRunDirectory, undefined);
});

test("parseCliArgs rejects --continue for extend", () => {
  assert.throws(
    () => cli.parseCliArgs(["extend", ".harness/spec.yaml", "--continue", "runs/x"]),
    /continues automatically/,
  );
});

test("printHelp documents extend contract", () => {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  try {
    cli.printHelp();
  } finally {
    console.log = original;
  }
  const help = lines.join("\n");
  assert.match(help, /hedera-harness extend <spec>/);
  assert.match(help, /continues automatically/i);
  assert.match(help, /Does not auto-stash/);
});

test("loadTemplateSpec allow missing seed for extend mode", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await makeTestTempDir("extend-spec-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# extend\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "[]\n");
  await writeFile(path.join(root, ".harness", "validators", "commands.json"), "[]\n");
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `name: no-seed-extend
prd: .harness/prd.md
generator:
  provider: command
  command: agent
extend:
  baseline:
    commands:
      - name: install
        command: yarn install
        timeoutMs: 300000
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/commands.json
requiredFiles: []
forbiddenFiles: []
logging:
  jsonl: .harness/runs/harness.log.jsonl
  notes: .harness/runs/harness-notes.md
`,
  );

  const loaded = await loadTemplateSpec(path.join(root, ".harness", "spec.yaml"), {
    requireSeed: false,
  });
  assert.equal(loaded.spec.seed, undefined);
  assert.equal(loaded.spec.name, "no-seed-extend");
  assert.equal(loaded.spec.extend?.baseline?.commands?.[0]?.name, "install");

  await assert.rejects(
    () => loadTemplateSpec(path.join(root, ".harness", "spec.yaml"), { requireSeed: true }),
    /seed/i,
  );
});

test("loadTemplateSpec rejects extend mode without baseline install command", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await makeTestTempDir("extend-baseline-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, ".harness", "prd.md"), "# extend\n");
  await writeFile(path.join(root, ".harness", "validators", "static.json"), "[]\n");
  await writeFile(path.join(root, ".harness", "validators", "commands.json"), "[]\n");
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `name: missing-install
prd: .harness/prd.md
generator:
  provider: command
  command: agent
extend:
  baseline:
    commands:
      - name: lint
        command: yarn lint
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/commands.json
requiredFiles: []
forbiddenFiles: []
logging:
  jsonl: .harness/runs/harness.log.jsonl
  notes: .harness/runs/harness-notes.md
`,
  );

  await assert.rejects(
    () => loadTemplateSpec(path.join(root, ".harness", "spec.yaml"), { requireSeed: false }),
    /named "install"/,
  );
});

test("buildExtendPrompt preserves existing app and points at runtime paths", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = await makeTestTempDir("extend-prompt-");
  const prdPath = path.join(dir, "prd.md");
  await writeFile(prdPath, "Add a tip jar panel.\n");

  const prompt = await prompts.buildExtendPrompt(
    {
      name: "demo",
      prdPath,
      requiredFiles: ["packages/nextjs/app/page.tsx"],
      forbiddenFiles: [],
      validators: {},
      generator: { provider: "command", command: "agent" },
      maxAttempts: 1,
      logging: { jsonlPath: "x", notesPath: "y" },
      constraints: { packageManager: "yarn" },
    },
    1,
    [
      {
        name: "hts",
        relativePath: `${EXTEND_SKILLS_DIR}/hts/SKILL.md`,
        description: "HTS skill",
        sourcePath: "/tmp/SKILL.md",
      },
    ],
    {
      prdRelativePath: `${EXTEND_CONTEXT_DIR}/prd.md`,
      contractRelativePath: `${EXTEND_CONTEXT_DIR}/acceptance-contract.json`,
      prdSourcePath: prdPath,
    },
  );

  assert.match(prompt, /existing scaffold-hbar application/i);
  assert.match(prompt, /do NOT rebuild the app from scratch/i);
  assert.match(prompt, new RegExp(EXTEND_CONTEXT_DIR));
  assert.match(prompt, new RegExp(EXTEND_SKILLS_DIR));
  assert.match(prompt, /Add a tip jar panel/);
});

test("workspace watcher ignores .harness runtime activity", () => {
  assert.equal(shouldIgnoreWorkspaceActivity(".harness/runtime/skills/x/SKILL.md"), true);
  assert.equal(shouldIgnoreWorkspaceActivity(".harness/runs/id/logs/a.log"), true);
  assert.equal(shouldIgnoreWorkspaceActivity("packages/nextjs/app/page.tsx"), false);
});
