import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { isReadyForPlaywrightSmoke } = await import(
  pathToFileURL(path.resolve("dist/validation/index.js")).href
);
const { mergeGenerateFinding } = await import(
  pathToFileURL(path.resolve("dist/attemptStages.js")).href
);
const { validateWorkspace } = await import(pathToFileURL(path.resolve("dist/runner.js")).href);

test("isReadyForPlaywrightSmoke ignores agent findings and blocks everything else", () => {
  assert.equal(isReadyForPlaywrightSmoke({ findings: [] }), true);
  assert.equal(
    isReadyForPlaywrightSmoke({
      findings: [{ id: "generator-exit:1", category: "agent", message: "boom" }],
    }),
    true,
  );
  assert.equal(
    isReadyForPlaywrightSmoke({
      findings: [{ id: "required-file:missing.txt", category: "files", message: "missing" }],
    }),
    false,
  );
  assert.equal(
    isReadyForPlaywrightSmoke({
      findings: [{ id: "command:install", category: "commands", message: "failed" }],
    }),
    false,
  );
});

test("mergeGenerateFinding keeps ASSERT pass and does not block smoke readiness", () => {
  const deterministic = {
    passed: true,
    findings: [],
    commandResults: [],
  };
  const merged = mergeGenerateFinding(deterministic, {
    id: "generator-timeout:1",
    category: "agent",
    message: "Generator agent timed out after 90s",
  });
  assert.equal(merged.passed, true);
  assert.equal(merged.findings.length, 1);
  assert.equal(isReadyForPlaywrightSmoke(merged), true);

  const dirty = mergeGenerateFinding(
    {
      passed: false,
      findings: [{ id: "command:build", category: "commands", message: "build failed" }],
      commandResults: [],
    },
    { id: "generator-timeout:1", category: "agent", message: "timed out" },
  );
  assert.equal(dirty.passed, false);
  assert.equal(isReadyForPlaywrightSmoke(dirty), false);
});

test("validate skips Playwright when a non-command deterministic finding is open", async () => {
  // Same predicate as runValidationStages: a missing required file must block the
  // gate even when commands pass — previously validate only skipped on commands.
  const root = await makeTestTempDir("validate-smoke-gate-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { required: [] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  // Deliberately unreachable — if the gate boots we will hang or fail loudly.
  await writeFile(
    path.join(root, ".harness", "validators", "playwright-smoke.yaml"),
    `name: must-not-boot
server:
  command: sleep 30
  url: http://127.0.0.1:1
  timeoutMs: 60000
routes:
  - name: home
    path: /
`,
  );
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 3
name: validate-smoke-gate
agent: claude
skills: []
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
  playwright: .harness/validators/playwright-smoke.yaml
requiredFiles:
  - missing-on-purpose.txt
baseline:
  commands:
    - name: install
      command: "true"
`,
  );

  const result = await validateWorkspace({
    specPath: path.join(root, ".harness", "spec.yaml"),
    workspacePath: root,
  });

  assert.equal(result.passed, false);
  assert.ok(result.findings.some(f => f.category === "files"));
  assert.equal(
    result.playwrightGate,
    undefined,
    "run and validate must agree: non-command ASSERT findings block SMOKE",
  );
  assert.equal(isReadyForPlaywrightSmoke(result), false);
});
