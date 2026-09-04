import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { makeTestTempDir } from "./tmpDir.mjs";

const gitMod = await import(pathToFileURL(path.resolve("dist/harnessGit.js")).href);
const cleanupMod = await import(pathToFileURL(path.resolve("dist/runCleanup.js")).href);
const outroMod = await import(pathToFileURL(path.resolve("dist/runOutro.js")).href);
const mcpMod = await import(pathToFileURL(path.resolve("dist/mcpBrowser.js")).href);

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function initRepo() {
  const root = await makeTestTempDir("extend-ckpt-");
  git(root, ["init", "--template="]);
  git(root, ["config", "user.email", "harness-test@example.com"]);
  git(root, ["config", "user.name", "Harness Test"]);
  await writeFile(path.join(root, "README.md"), "# demo\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "init"]);
  return root;
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

test("formatAttemptCommitMessage includes finding IDs in body", () => {
  const { subject, body } = gitMod.formatAttemptCommitMessage({
    attempt: 2,
    passed: true,
    findings: [
      { id: "gate-a", category: "deterministic", message: "a" },
      { id: "gate-b", category: "agent", message: "b" },
    ],
  });
  assert.equal(subject, "harness: run attempt 2 passed");
  assert.match(body, /Finding IDs: gate-a, gate-b/);
  assert.match(body, /squash attempt commits/i);
});

test("filterCommitableHarnessEntries skips secrets and runtime", () => {
  const { commitable, skippedSecrets } = gitMod.filterCommitableHarnessEntries([
    { code: "??", path: "src/app.ts" },
    { code: "??", path: ".env" },
    { code: "??", path: ".harness/runtime/skills/x/SKILL.md" },
    { code: " M", path: ".cursor/mcp.json" },
    { code: "??", path: "secrets/token.txt" },
  ]);
  assert.deepEqual(
    commitable.map(entry => entry.path),
    ["src/app.ts"],
  );
  assert.deepEqual(
    skippedSecrets.map(entry => entry.path).sort(),
    [".env", "secrets/token.txt"].sort(),
  );
});

test("commitAttempt never stages secrets or runtime; records finding IDs", async () => {
  const root = await initRepo();
  await gitMod.createAndCheckoutHarnessBranch(root, "secret-demo", "s3cret");
  await mkdir(path.join(root, ".harness", "runtime", "skills"), { recursive: true });
  await writeFile(path.join(root, ".harness", "runtime", "skills", "SKILL.md"), "# skill\n");
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(root, "feature.ts"), "export const ok = true;\n");

  const findings = [{ id: "missing-route", category: "deterministic", message: "missing" }];
  const result = await gitMod.commitAttempt(root, 1, false, findings);
  assert.equal(result.committed, true);
  assert.deepEqual(result.skippedSecrets, [".env"]);
  assert.match(result.message, /run attempt 1 failed/);

  const showNames = git(root, ["show", "--name-only", "--pretty=format:", "HEAD"]);
  assert.match(showNames, /feature\.ts/);
  assert.doesNotMatch(showNames, /\.env/);
  assert.doesNotMatch(showNames, /runtime/);

  const showBody = git(root, ["log", "-1", "--format=%B"]);
  assert.match(showBody, /Finding IDs: missing-route/);
});

test("cleanupRuntimeInjections removes runtime/MCP but keeps runs", async () => {
  const root = await initRepo();
  await mkdir(path.join(root, ".harness", "runtime", "context"), { recursive: true });
  await writeFile(path.join(root, ".harness", "runtime", "context", "prd.md"), "# prd\n");
  await mkdir(path.join(root, ".harness-skills"), { recursive: true });
  await writeFile(path.join(root, ".harness-skills", "SKILL.md"), "# skill\n");
  await mkdir(path.join(root, ".harness", "runs", "run-1"), { recursive: true });
  await writeFile(
    path.join(root, ".harness", "runs", "run-1", "session.json"),
    JSON.stringify({ sessionId: "run-1" }),
  );
  await writeFile(
    path.join(root, ".harness", "runs", "run-1", "chain-signer.json"),
    JSON.stringify({ privateKey: "x" }),
  );

  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          playwright: await mcpMod.playwrightMcpServer(root),
          other: { command: "echo" },
        },
      },
      null,
      2,
    )}\n`,
  );

  const cleanup = await cleanupMod.cleanupRuntimeInjections(root);
  assert.ok(cleanup.removedPaths.includes(".harness/runtime"));
  assert.ok(cleanup.removedPaths.includes(".harness-skills"));
  assert.equal(cleanup.mcpStripped, true);
  assert.equal(await pathExists(path.join(root, ".harness", "runtime")), false);
  assert.equal(await pathExists(path.join(root, ".harness-skills")), false);
  assert.equal(await pathExists(path.join(root, ".harness", "runs", "run-1", "session.json")), true);
  assert.equal(
    await pathExists(path.join(root, ".harness", "runs", "run-1", "chain-signer.json")),
    false,
  );

  const mcp = JSON.parse(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.playwright, undefined);
  assert.ok(mcp.mcpServers.other);
});

test("cleanup never strips a playwright server the user wrote themselves", async () => {
  const root = await initRepo();
  await mkdir(path.join(root, ".cursor"), { recursive: true });

  // The shape a user actually writes — same server name, no harness marker.
  const userServer = { command: "npx", args: ["@playwright/mcp@latest"] };
  await writeFile(
    path.join(root, ".cursor", "mcp.json"),
    `${JSON.stringify({ mcpServers: { playwright: userServer } }, null, 2)}\n`,
  );

  const cleanup = await cleanupMod.cleanupRuntimeInjections(root);
  assert.equal(cleanup.mcpStripped, false, "a user's own server is not a harness injection");

  const mcp = JSON.parse(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.playwright, userServer, "user config must survive untouched");
});

test("formatRunOutro success prints push/PR instructions without implying execution", () => {
  const lines = outroMod.formatRunOutro({
    report: {
      passed: true,
      workspacePath: "/tmp/app",
      runDirectory: "/tmp/app/.harness/runs/abc",
      attempts: 2,
      maxAttempts: 3,
      attemptsThisCycle: 2,
      openFindingIds: [],
      fixedFindingIds: ["static:missing-page"],
      validation: {
        findings: [
          { id: "static:missing-page", category: "static", message: "was missing", status: "fixed" },
        ],
      },
    },
    session: {
      branch: "harness/run-demo-abc123",
      baseBranch: "main",
      baseSha: "deadbeefcafebabe",
    },
    cleanup: {
      removedPaths: [".harness/runtime"],
      mcpStripped: false,
      consumerDirtyPaths: [],
      treeClean: true,
    },
    specPath: ".harness/spec.yaml",
  });
  const text = lines.join("\n");
  assert.match(text, /Run PASSED/);
  assert.match(text, /git push -u origin harness\/run-demo-abc123/);
  assert.match(text, /gh pr create --base main/);
  assert.match(text, /did not push, open a PR, merge/);
  assert.doesNotMatch(text, /git checkout main/);
});

test("formatRunOutro failure prints continue/abandon and stays on harness branch", () => {
  const lines = outroMod.formatRunOutro({
    report: {
      passed: false,
      workspacePath: "/tmp/app",
      runDirectory: "/tmp/app/.harness/runs/abc",
      attempts: 3,
      maxAttempts: 3,
      openFindingIds: ["x"],
      fixedFindingIds: [],
      validation: {
        findings: [{ id: "x", category: "deterministic", message: "broken", status: "open" }],
      },
    },
    session: {
      branch: "harness/run-demo-abc123",
      baseBranch: "main",
      baseSha: "deadbeefcafebabe",
    },
    cleanup: {
      removedPaths: [],
      mcpStripped: true,
      consumerDirtyPaths: [],
      treeClean: true,
    },
    specPath: ".harness/spec.yaml",
  });
  const text = lines.join("\n");
  assert.match(text, /Run FAILED/);
  assert.match(text, /hedera-harness run \.harness\/spec\.yaml/);
  assert.match(text, /git checkout main/);
  assert.match(text, /git branch -D harness\/run-demo-abc123/);
  assert.match(text, /did not push, open a PR, merge/);
  assert.doesNotMatch(text, /Optional next steps \(run manually\)/);
});
