import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { withValidatorMcp } = await import(
  pathToFileURL(path.resolve("dist/validatorMcp.js")).href
);

test("Claude ignores a project MCP file and receives a strict harness-owned config", async () => {
  const root = await makeTestTempDir("validator-mcp-claude-");
  const runDirectory = path.join(root, ".harness", "runs", "r1");
  const projectMcpPath = path.join(root, ".mcp.json");
  const projectMcp = `${JSON.stringify({
    mcpServers: { playwright: { command: "must-not-be-used" } },
  })}\n`;
  await writeFile(projectMcpPath, projectMcp);

  let receivedArgs;
  await withValidatorMcp(
    {
      agent: "claude",
      workspacePath: root,
      artifactsDirectory: runDirectory,
    },
    async args => {
      receivedArgs = args;
      const configIndex = args.indexOf("--mcp-config");
      assert.notEqual(configIndex, -1);
      assert.ok(args.includes("--strict-mcp-config"));

      const config = JSON.parse(await readFile(args[configIndex + 1], "utf8"));
      assert.ok(config.mcpServers.playwright);
    },
  );

  assert.ok(receivedArgs);
  assert.equal(await readFile(projectMcpPath, "utf8"), projectMcp);
  await assert.rejects(() => readFile(path.join(root, ".cursor", "mcp.json"), "utf8"));
});

test("Cursor sees a temporary MCP entry and the user's config is restored", async () => {
  const root = await makeTestTempDir("validator-mcp-cursor-");
  const runDirectory = path.join(root, ".harness", "runs", "r1");
  const mcpPath = path.join(root, ".cursor", "mcp.json");
  await mkdir(path.dirname(mcpPath), { recursive: true });
  const original = `${JSON.stringify(
    { mcpServers: { keep: { command: "existing-server" } } },
    null,
    2,
  )}\n`;
  await writeFile(mcpPath, original);

  await withValidatorMcp(
    {
      agent: "cursor",
      workspacePath: root,
      artifactsDirectory: runDirectory,
    },
    async args => {
      assert.deepEqual(args, []);
      const during = JSON.parse(await readFile(mcpPath, "utf8"));
      assert.equal(during.mcpServers.keep.command, "existing-server");
      assert.ok(during.mcpServers.playwright);
    },
  );

  assert.equal(await readFile(mcpPath, "utf8"), original);
});
