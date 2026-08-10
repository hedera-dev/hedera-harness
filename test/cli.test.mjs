import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const prompts = await import(pathToFileURL(path.resolve("dist/promptBuilder.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);
const { HARNESS_CONTEXT_DIR, HARNESS_SKILLS_DIR } = await import(
  pathToFileURL(path.resolve("dist/runtimePaths.js")).href
);
const { shouldIgnoreWorkspaceActivity } = await import(
  pathToFileURL(path.resolve("dist/workspaceWatcher.js")).href
);

test("parseCliArgs accepts run with max-attempts and defaults workspace to unset (cwd)", () => {
  const parsed = cli.parseCliArgs(["run", ".harness/spec.yaml", "--max-attempts", "3"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.specPath, ".harness/spec.yaml");
  assert.equal(parsed.options.maxAttempts, 3);
  assert.equal(parsed.options.workspacePath, undefined);
  assert.equal(parsed.options.forceNew, undefined);
  assert.equal(parsed.options.continueBranch, undefined);
});

test("parseCliArgs defaults run spec to .harness/spec.yaml", () => {
  const parsed = cli.parseCliArgs(["run", "--max-attempts", "2"]);
  assert.equal(parsed.command, "run");
  assert.equal(parsed.options.specPath, ".harness/spec.yaml");
  assert.equal(parsed.options.maxAttempts, 2);
});

test("parseCliArgs accepts --new and --continue <branch> for run", () => {
  const fresh = cli.parseCliArgs(["run", ".harness/spec.yaml", "--new"]);
  assert.equal(fresh.options.forceNew, true);

  const cont = cli.parseCliArgs([
    "run",
    ".harness/spec.yaml",
    "--continue",
    "harness/run-my-feature-abc123",
  ]);
  assert.equal(cont.options.continueBranch, "harness/run-my-feature-abc123");
});

test("parseCliArgs rejects --new with --continue", () => {
  assert.throws(
    () =>
      cli.parseCliArgs([
        "run",
        ".harness/spec.yaml",
        "--new",
        "--continue",
        "harness/run-x-abc123",
      ]),
    /both --new and --continue/,
  );
});

test("parseCliArgs accepts validate without --workspace (cwd default at runtime)", () => {
  const parsed = cli.parseCliArgs(["validate", ".harness/spec.yaml"]);
  assert.equal(parsed.command, "validate");
  assert.equal(parsed.options.specPath, ".harness/spec.yaml");
  assert.equal(parsed.options.workspacePath, undefined);
});

test("parseCliArgs defaults validate and validate-semantic spec to .harness/spec.yaml", () => {
  const validate = cli.parseCliArgs(["validate"]);
  assert.equal(validate.command, "validate");
  assert.equal(validate.options.specPath, ".harness/spec.yaml");

  const semantic = cli.parseCliArgs(["validate-semantic"]);
  assert.equal(semantic.command, "validate-semantic");
  assert.equal(semantic.options.specPath, ".harness/spec.yaml");
});

test("parseCliArgs rejects removed extend command", () => {
  assert.throws(
    () => cli.parseCliArgs(["extend", ".harness/spec.yaml"]),
    /Expected command "init", "run"/,
  );
});

test("parseCliArgs accepts init with target and flags", () => {
  const parsed = cli.parseCliArgs([
    "init",
    "my-app",
    "--repo",
    "https://github.com/hedera-dev/scaffold-hbar.git",
    "--ref",
    "main",
    "--skip-install",
  ]);
  assert.equal(parsed.command, "init");
  assert.equal(parsed.initOptions?.targetDir, "my-app");
  assert.equal(parsed.initOptions?.repo, "https://github.com/hedera-dev/scaffold-hbar.git");
  assert.equal(parsed.initOptions?.ref, "main");
  assert.equal(parsed.initOptions?.skipInstall, true);
});

test("printHelp documents init and project-centric run", () => {
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
  assert.match(help, /hedera-harness init/);
  assert.match(help, /hedera-harness run/);
  assert.match(help, /continues automatically/i);
  assert.match(help, /--new/);
  assert.doesNotMatch(help, /hedera-harness extend/);
  assert.match(help, /Does not auto-stash/);
});

test("loadTemplateSpec allow missing seed for project-centric mode", async () => {
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

test("loadTemplateSpec rejects project-centric mode without baseline install command", async () => {
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

test("buildSessionPrompt preserves existing app and points at runtime paths", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = await makeTestTempDir("extend-prompt-");
  const prdPath = path.join(dir, "prd.md");
  await writeFile(prdPath, "Add a tip jar panel.\n");

  const prompt = await prompts.buildSessionPrompt(
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
        relativePath: `${HARNESS_SKILLS_DIR}/hts/SKILL.md`,
        description: "HTS skill",
        sourcePath: "/tmp/SKILL.md",
      },
    ],
    {
      prdRelativePath: `${HARNESS_CONTEXT_DIR}/prd.md`,
      contractRelativePath: `${HARNESS_CONTEXT_DIR}/acceptance-contract.json`,
      prdSourcePath: prdPath,
    },
  );

  assert.match(prompt, /existing scaffold-hbar application/i);
  assert.match(prompt, /do NOT rebuild the app from scratch/i);
  assert.match(prompt, new RegExp(HARNESS_CONTEXT_DIR));
  assert.match(prompt, new RegExp(HARNESS_SKILLS_DIR));
  assert.match(prompt, /Add a tip jar panel/);
});

test("workspace watcher ignores .harness runtime activity", () => {
  assert.equal(shouldIgnoreWorkspaceActivity(".harness/runtime/skills/x/SKILL.md"), true);
  assert.equal(shouldIgnoreWorkspaceActivity(".harness/runs/id/logs/a.log"), true);
  assert.equal(shouldIgnoreWorkspaceActivity("packages/nextjs/app/page.tsx"), false);
});
