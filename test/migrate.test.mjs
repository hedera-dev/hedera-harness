import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { migrateSpecFile } = await import(pathToFileURL(path.resolve("dist/migrate.js")).href);
const { loadTemplateSpec } = await import(pathToFileURL(path.resolve("dist/specLoader.js")).href);

async function writeSpec(body, prefix = "migrate-") {
  const root = await makeTestTempDir(prefix);
  await mkdir(path.join(root, ".harness"), { recursive: true });
  const specPath = path.join(root, ".harness", "spec.yaml");
  await writeFile(specPath, body);
  return { root, specPath };
}

const V1 = `name: demo
prd: .harness/prd.md

generator:
  provider: command
  command: agent
  args:
    - -p
    - --trust
    - --sandbox
    - enabled
    - --workspace
    - "{workspace}"
    - --model
    - composer-2.5
    - --force
    - --output-format
    - stream-json
    - --stream-partial-output
  timeoutMs: 3600000

constraints:
  packageManager: yarn@3.2.3
  workspaces:
    - packages/nextjs
  forbiddenCommands:
    - npm install
    - npm run
    - pnpm install
    - pnpm run

extend:
  baseline:
    commands:
      - name: install
        command: yarn install

validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json

requiredFiles:
  - README.md
  - .harness/spec.yaml
  - .harness/prd.md

forbiddenFiles:
  - .env
  - packages/nextjs/.env

maxAttempts: 3

logging:
  jsonl: .harness/runs/harness.log.jsonl
  notes: .harness/runs/harness-notes.md
`;

function keys(result, list) {
  return result[list].map(change => change.key);
}

test("a fully default v1 recipe collapses to its template-specific parts", async () => {
  const { specPath } = await writeSpec(V1);

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.equal(result.fromVersion, 1);
  assert.equal(result.changed, true);
  assert.ok(result.afterLines < result.beforeLines, "should get shorter");

  const removed = keys(result, "changes");
  for (const key of ["generator", "prd", "maxAttempts", "logging", "validators.static"]) {
    assert.ok(removed.includes(key), `${key} should be removed; got ${removed.join(", ")}`);
  }
  assert.ok(removed.includes("schemaVersion"), "schemaVersion should be added");
  assert.match(result.after, /^schemaVersion: 2/, "schemaVersion should come first");
});

test("dry run does not touch the file", async () => {
  const { specPath } = await writeSpec(V1);
  const before = await readFile(specPath, "utf8");

  await migrateSpecFile(specPath, { dryRun: true });

  assert.equal(await readFile(specPath, "utf8"), before);
});

test("a value that differs from the default is kept, not dropped", async () => {
  // The safety property: a recipe adding a forbidden command is expressing
  // intent, and removing it would silently weaken the recipe.
  const { specPath } = await writeSpec(
    V1.replace("    - pnpm run\n", "    - pnpm run\n    - docker *\n"),
  );

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.ok(
    keys(result, "kept").includes("constraints.forbiddenCommands"),
    "a superset forbiddenCommands must be kept",
  );
  assert.ok(result.after.includes("docker *"), "the extra entry must survive");
});

test("a generator with unrecognised flags is preserved verbatim", async () => {
  const { specPath } = await writeSpec(V1.replace("    - --force\n", "    - --force\n    - --wild\n"));

  const result = await migrateSpecFile(specPath, { dryRun: true });

  const keptGenerator = result.kept.find(change => change.key === "generator");
  assert.ok(keptGenerator, "generator should be kept");
  assert.match(keptGenerator.reason, /--wild/);
  assert.ok(result.after.includes("--wild"));
});

test("a generator pinning a non-default model is preserved", async () => {
  const { specPath } = await writeSpec(V1.replace("composer-2.5", "composer-9.9"));

  const result = await migrateSpecFile(specPath, { dryRun: true });

  const keptGenerator = result.kept.find(change => change.key === "generator");
  assert.ok(keptGenerator, "generator should be kept");
  assert.match(keptGenerator.reason, /composer-9\.9/);
});

test("a claude generator becomes the default and omits agent:", async () => {
  const { specPath } = await writeSpec(`name: demo
generator:
  provider: command
  command: claude
  args:
    - -p
    - "{prompt}"
    - --model
    - opus
extend:
  baseline:
    commands:
      - name: install
        command: "true"
`);

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.ok(!keys(result, "changes").includes("agent"), "default preset needs no agent: key");
  assert.ok(!/^\s*agent:/m.test(result.after));
  assert.ok(!result.after.includes("generator:"));
});

test("a cursor generator becomes explicit agent: cursor", async () => {
  const { specPath } = await writeSpec(V1);

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.ok(keys(result, "changes").includes("agent"));
  assert.match(result.after, /agent: cursor/);
});

test("extend.baseline is renamed and its commands survive intact", async () => {
  const { specPath } = await writeSpec(V1);

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.ok(keys(result, "changes").some(key => key.includes("baseline")));
  assert.match(result.after, /^baseline:/m);
  assert.doesNotMatch(result.after, /^extend:/m);
  assert.match(result.after, /command: yarn install/);
});

test("self-referential requiredFiles entries are dropped, others kept", async () => {
  const { specPath } = await writeSpec(V1);

  const result = await migrateSpecFile(specPath, { dryRun: true });

  assert.match(result.after, /- README\.md/);
  assert.doesNotMatch(result.after, /- \.harness\/spec\.yaml/);
  assert.doesNotMatch(result.after, /- \.harness\/prd\.md/);
});

test("migrating is idempotent and a v2 recipe is left alone", async () => {
  const { specPath } = await writeSpec(V1);

  await migrateSpecFile(specPath);
  const once = await readFile(specPath, "utf8");

  const second = await migrateSpecFile(specPath);
  assert.equal(second.changed, false, "second run should be a no-op");
  assert.equal(await readFile(specPath, "utf8"), once);
});

test("the migrated recipe loads to the same spec, apart from intended changes", async () => {
  const { root, specPath } = await writeSpec(V1);
  const originalPath = path.join(root, ".harness", "original.yaml");
  await writeFile(originalPath, V1);

  await migrateSpecFile(specPath);

  const before = (await loadTemplateSpec(originalPath)).spec;
  const after = (await loadTemplateSpec(specPath)).spec;

  // agent: old v1 files often omit it; loading them now defaults to claude, while
  // migrate writes agent: cursor for a Cursor generator so behavior is preserved.
  const intentionallyDifferent = new Set(["schemaVersion", "generator", "requiredFiles", "agent"]);
  for (const key of Object.keys(before)) {
    if (intentionallyDifferent.has(key)) continue;
    assert.deepEqual(after[key], before[key], `${key} should survive migration unchanged`);
  }

  assert.equal(after.agent, "cursor", "Cursor generator must become explicit agent: cursor");

  // requiredFiles differs only by the dropped tautologies.
  assert.deepEqual(
    before.requiredFiles.filter(f => !after.requiredFiles.includes(f)),
    [".harness/spec.yaml", ".harness/prd.md"],
  );
  assert.deepEqual(after.requiredFiles.filter(f => !before.requiredFiles.includes(f)), []);

  // The generator keeps its command and gains only preset flags.
  assert.equal(after.generator.command, before.generator.command);
  assert.deepEqual(
    before.generator.args.filter(a => !after.generator.args.includes(a)),
    [],
    "no generator flag should be lost",
  );
});
