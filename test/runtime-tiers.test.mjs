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

/**
 * SMOKE and EVALUATE are the two stages the scaffold-hbar e2e never reaches,
 * because that recipe enables neither `validator` nor `validators.playwright`.
 * This drives both against a real dev server and a real browser using a fixture
 * app, so the runtime half of the loop is actually exercised somewhere.
 *
 * What is still not covered: an agent driving the browser through MCP. That needs
 * a real model. What *is* covered is that the harness boots the app, walks its
 * routes with Chromium, hands the validator a live URL, delivers the MCP config
 * the way the agent's preset expects, and parses the verdict.
 */
const FIXTURE_SERVER = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><h1>Fixture app</h1><p>This page has enough visible text to count as rendered.</p></body></html>");
});
server.listen(0, "127.0.0.1", () => {
  // The harness detects the URL from this line.
  console.log("Local: http://127.0.0.1:" + server.address().port);
});
`;

const MOCK_GENERATOR = `
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const ws = process.env.MOCK_WS;
mkdirSync(path.join(ws, "built"), { recursive: true });
writeFileSync(path.join(ws, "built", "feature.txt"), "done");
`;

/** Records its argv so the test can assert how MCP config was delivered. */
const MOCK_VALIDATOR = `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.MOCK_VALIDATOR_ARGV, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  passed: true,
  summary: "Fixture app renders and the home route is reachable.",
  issues: [],
}));
`;

async function makeTier3Project() {
  const root = await makeTestTempDir("tiers-");
  await mkdir(path.join(root, ".harness", "validators"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
  await writeFile(path.join(root, "server.mjs"), FIXTURE_SERVER);
  await writeFile(path.join(root, "agent.mjs"), MOCK_GENERATOR);
  await writeFile(path.join(root, "validator.mjs"), MOCK_VALIDATOR);
  await writeFile(path.join(root, ".harness", "prd.md"), "Serve a home page.\n");

  await writeFile(
    path.join(root, ".harness", "validators", "static.json"),
    JSON.stringify({ fileAssertions: { required: ["server.mjs"] } }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "yarn.json"),
    JSON.stringify({ commands: [{ name: "install", command: "true" }] }),
  );
  await writeFile(
    path.join(root, ".harness", "validators", "playwright-smoke.yaml"),
    `name: fixture-smoke
server:
  command: node server.mjs
  url: http://127.0.0.1:0
  timeoutMs: 30000
routes:
  - name: home
    path: /
`,
  );
  await writeFile(
    path.join(root, ".harness", "acceptance-contract.json"),
    JSON.stringify({
      assertions: [
        { id: "C1", statement: "Home route renders", route: "/", severity: "critical" },
      ],
    }),
  );

  // agent: claude selects config-flag MCP delivery, so the validator should be
  // handed --mcp-config rather than the project getting a .cursor/mcp.json.
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `schemaVersion: 2
name: tier3-fixture
agent: claude
contract: .harness/acceptance-contract.json
skills: []
generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(path.join(root, "agent.mjs"))}
  timeoutMs: 60000
validator:
  enabled: true
  command: node
  args:
    - ${JSON.stringify(path.join(root, "validator.mjs"))}
  timeoutMs: 60000
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
  playwright: .harness/validators/playwright-smoke.yaml
baseline:
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

test("SMOKE and EVALUATE run against a real dev server and browser", async () => {
  const root = await makeTier3Project();
  const argvFile = path.join(root, "validator-argv.json");

  const previous = { ...process.env };
  Object.assign(process.env, {
    MOCK_WS: root,
    MOCK_VALIDATOR_ARGV: argvFile,
    HUSKY: "0",
  });

  let result;
  try {
    result = await runSession({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
      skipToolChecks: true,
    });
  } finally {
    for (const key of ["MOCK_WS", "MOCK_VALIDATOR_ARGV", "HUSKY"]) delete process.env[key];
    Object.assign(process.env, previous);
  }

  const { report } = result;

  // SMOKE: the app was booted and its routes walked with a real browser.
  assert.ok(report.validation.playwrightGate, "playwright gate should have run");
  assert.equal(report.validation.playwrightGate.passed, true);
  assert.deepEqual(
    report.validation.playwrightGate.routes.map(r => r.name),
    ["home"],
  );
  assert.equal(report.validation.playwrightGate.routes[0].rendered, true);

  // EVALUATE: the validator was invoked against the live server and its verdict parsed.
  assert.ok(report.semanticValidation, "semantic validation should have run");
  assert.equal(report.semanticValidation.passed, true);
  assert.match(report.semanticValidation.verdict.summary, /Fixture app renders/);
  assert.match(report.semanticValidation.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  assert.equal(report.passed, true);
}, { timeout: 180_000 });

test("a claude validator is handed --mcp-config and the project is not touched", async () => {
  const root = await makeTier3Project();
  const argvFile = path.join(root, "validator-argv.json");

  const previous = { ...process.env };
  Object.assign(process.env, { MOCK_WS: root, MOCK_VALIDATOR_ARGV: argvFile, HUSKY: "0" });
  try {
    await runSession({
      specPath: path.join(root, ".harness", "spec.yaml"),
      workspacePath: root,
      skipToolChecks: true,
    });
  } finally {
    for (const key of ["MOCK_WS", "MOCK_VALIDATOR_ARGV", "HUSKY"]) delete process.env[key];
    Object.assign(process.env, previous);
  }

  const argv = JSON.parse(await readFile(argvFile, "utf8"));
  const flagIndex = argv.indexOf("--mcp-config");
  assert.ok(flagIndex >= 0, `validator should receive --mcp-config; got ${argv.join(" ")}`);

  const configPath = argv[flagIndex + 1];
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.ok(config.mcpServers.playwright, "the config should declare the playwright server");

  // The whole point of config-flag delivery: the project is left alone.
  await assert.rejects(
    () => readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    "a claude run must not write .cursor/mcp.json",
  );
}, { timeout: 180_000 });
