import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const mcp = await import(pathToFileURL(path.resolve("dist/playwrightMcp.js")).href);
const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);

function opts(userConfigPath) {
  return { userConfigPath };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("parseCliArgs accepts mcp status enable install", () => {
  const status = cli.parseCliArgs(["mcp", "status", "--workspace", "D:\\app"]);
  assert.equal(status.command, "mcp");
  assert.equal(status.mcpOptions?.subcommand, "status");
  assert.equal(status.mcpOptions?.workspace, "D:\\app");

  const enable = cli.parseCliArgs(["mcp", "enable"]);
  assert.equal(enable.mcpOptions?.subcommand, "enable");

  const install = cli.parseCliArgs(["mcp", "install"]);
  assert.equal(install.mcpOptions?.subcommand, "install");
});

test("parseCliArgs rejects unknown mcp subcommands", () => {
  assert.throws(() => cli.parseCliArgs(["mcp", "wipe"]), /status", "enable", or "install"/);
});

test("inspectPlaywrightMcp is missing when neither project nor user config has Playwright", async () => {
  const root = await makeTestTempDir("mcp-missing-");
  const userConfigPath = path.join(root, "user-opencode.json");
  const status = mcp.inspectPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(status.kind, "missing");
  assert.equal(status.hits.length, 0);
  assert.match(mcp.formatPlaywrightMcpStatus(status), /kind=missing/);
  assert.match(mcp.formatPlaywrightMcpStatus(status), /e2e=playwright-mcp/);
});

test("inspectPlaywrightMcp reports disabled v1 enabled:false", async () => {
  const root = await makeTestTempDir("mcp-v1-off-");
  const userConfigPath = path.join(root, "user-opencode.json");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@latest"],
        enabled: false,
      },
    },
  });
  const status = mcp.inspectPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(status.kind, "disabled");
  assert.equal(status.hits[0].enabled, false);
  assert.equal(status.hits[0].container, "mcp");
});

test("inspectPlaywrightMcp reports disabled v2 mcp.servers disabled:true", async () => {
  const root = await makeTestTempDir("mcp-v2-off-");
  const userConfigPath = path.join(root, "user-opencode.json");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      servers: {
        playwright: {
          type: "local",
          command: ["npx", "-y", "@playwright/mcp@latest"],
          disabled: true,
        },
      },
    },
  });
  const status = mcp.inspectPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(status.kind, "disabled");
  assert.equal(status.hits[0].container, "mcp.servers");
});

test("inspectPlaywrightMcp treats tools.playwright false as disabled", async () => {
  const root = await makeTestTempDir("mcp-tools-off-");
  const userConfigPath = path.join(root, "user-opencode.json");
  await writeJson(path.join(root, "opencode.json"), {
    tools: { playwright: false },
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@latest"],
        enabled: true,
      },
    },
  });
  const status = mcp.inspectPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(status.kind, "disabled");
});

test("enablePlaywrightMcp flips a project disabled entry and does not write user config", async () => {
  const root = await makeTestTempDir("mcp-enable-");
  const userConfigPath = path.join(root, "never-touch-user.json");
  await writeJson(path.join(root, "opencode.json"), {
    tools: { playwright: false },
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@latest"],
        enabled: false,
      },
    },
  });
  const after = mcp.enablePlaywrightMcp(root, opts(userConfigPath));
  assert.equal(after.kind, "ready");
  const project = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.equal(project.mcp.playwright.enabled, true);
  assert.equal(project.tools.playwright, true);
  assert.equal(existsSync(userConfigPath), false);
});

test("enablePlaywrightMcp flips a disabled entry that already lives in user config", async () => {
  const root = await makeTestTempDir("mcp-enable-user-");
  const userConfigPath = path.join(root, "user", "opencode.json");
  await writeJson(userConfigPath, {
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "-y", "@playwright/mcp@latest"],
        enabled: false,
      },
    },
  });
  const after = mcp.enablePlaywrightMcp(root, opts(userConfigPath));
  assert.equal(after.kind, "ready");
  const user = JSON.parse(await readFile(userConfigPath, "utf8"));
  assert.equal(user.mcp.playwright.enabled, true);
  assert.equal(existsSync(path.join(root, "opencode.json")), false);
});

test("installPlaywrightMcp enables a disabled user-config entry instead of writing a project copy", async () => {
  const root = await makeTestTempDir("mcp-install-enable-");
  const userConfigPath = path.join(root, "user", "opencode.json");
  await writeJson(userConfigPath, {
    mcp: {
      playwright: {
        type: "local",
        command: ["npx", "@playwright/mcp@latest"],
        enabled: false,
      },
    },
  });
  const after = mcp.installPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(after.kind, "ready");
  const user = JSON.parse(await readFile(userConfigPath, "utf8"));
  assert.equal(user.mcp.playwright.enabled, true);
  assert.equal(existsSync(path.join(root, "opencode.json")), false);
});

test("installPlaywrightMcp writes project opencode.json only", async () => {
  const root = await makeTestTempDir("mcp-install-");
  const userDir = path.join(root, "fake-home", ".config", "opencode");
  const userConfigPath = path.join(userDir, "opencode.json");
  await writeJson(userConfigPath, { $schema: "https://opencode.ai/config.json" });
  const beforeUser = await readFile(userConfigPath, "utf8");

  const after = mcp.installPlaywrightMcp(root, opts(userConfigPath));
  assert.equal(after.kind, "ready");
  const project = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.equal(project.mcp.playwright.enabled, true);
  assert.deepEqual(project.mcp.playwright.command, ["npx", "-y", "@playwright/mcp@latest"]);
  assert.equal(await readFile(userConfigPath, "utf8"), beforeUser);
});

test("installPlaywrightMcp merges into existing mcp.servers without rewriting user config", async () => {
  const root = await makeTestTempDir("mcp-install-v2-");
  const userConfigPath = path.join(root, "user-opencode.json");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      servers: {
        other: { type: "local", command: ["echo"] },
      },
    },
  });
  mcp.installPlaywrightMcp(root, opts(userConfigPath));
  const project = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.ok(project.mcp.servers.other);
  assert.equal(project.mcp.servers.playwright.enabled, true);
  assert.equal(existsSync(userConfigPath), false);
});
