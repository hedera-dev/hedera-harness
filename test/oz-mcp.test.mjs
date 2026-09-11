import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const oz = await import(pathToFileURL(path.resolve("dist/ozMcp.js")).href);

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

test("ozMcpNeeded skips payments and HTS", () => {
  assert.equal(oz.ozMcpNeeded("none", "none"), false);
  assert.equal(oz.ozMcpNeeded("solidity", "hts"), false);
  assert.equal(oz.ozMcpNeeded("solidity", "none"), false);
  assert.equal(oz.ozMcpNeeded("solidity", "escrow"), true);
  assert.equal(oz.ozMcpNeeded("solidity", "token"), true);
});

test("inspectOzMcp is missing without a project entry", async () => {
  const root = await makeTestTempDir("oz-missing-");
  const status = oz.inspectOzMcp(root);
  assert.equal(status.kind, "missing");
  assert.match(oz.formatOzMcpStatus(status), /kind=missing/);
  assert.match(oz.formatOzMcpStatus(status), /mcp=openzeppelin-solidity/);
});

test("inspectOzMcp reports disabled overlay entry", async () => {
  const root = await makeTestTempDir("oz-off-");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      "openzeppelin-solidity": {
        type: "remote",
        url: oz.OPENZEPPELIN_MCP_URL,
        enabled: false,
      },
    },
  });
  const status = oz.inspectOzMcp(root);
  assert.equal(status.kind, "disabled");
  assert.equal(status.hits[0].enabled, false);
});

test("enableOzMcp flips a disabled project entry and does not invent user config", async () => {
  const root = await makeTestTempDir("oz-enable-");
  const configPath = path.join(root, "opencode.json");
  await writeJson(configPath, {
    mcp: {
      "openzeppelin-solidity": {
        type: "remote",
        url: oz.OPENZEPPELIN_MCP_URL,
        enabled: false,
        oauth: false,
      },
    },
  });
  const after = oz.enableOzMcp(root);
  assert.equal(after.kind, "ready");
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(parsed.mcp["openzeppelin-solidity"].enabled, true);
  assert.equal(parsed.mcp["openzeppelin-solidity"].url, oz.OPENZEPPELIN_MCP_URL);
});

test("ensureOzMcpForContracts skips HTS and payments", async () => {
  const root = await makeTestTempDir("oz-skip-");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      "openzeppelin-solidity": {
        type: "remote",
        url: oz.OPENZEPPELIN_MCP_URL,
        enabled: false,
      },
    },
  });
  const skipped = oz.ensureOzMcpForContracts(root, "none", "none");
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.justEnabled, false);
  assert.equal(oz.inspectOzMcp(root).kind, "disabled");

  const hts = oz.ensureOzMcpForContracts(root, "solidity", "hts");
  assert.equal(hts.skipped, true);
  assert.equal(oz.inspectOzMcp(root).kind, "disabled");
});

test("ensureOzMcpForContracts enables escrow solidity once", async () => {
  const root = await makeTestTempDir("oz-ensure-");
  await writeJson(path.join(root, "opencode.json"), {
    mcp: {
      "openzeppelin-solidity": {
        type: "remote",
        url: oz.OPENZEPPELIN_MCP_URL,
        enabled: false,
      },
    },
  });
  const first = oz.ensureOzMcpForContracts(root, "solidity", "escrow");
  assert.equal(first.skipped, false);
  assert.equal(first.justEnabled, true);
  assert.equal(first.status.kind, "ready");
  const second = oz.ensureOzMcpForContracts(root, "solidity", "escrow");
  assert.equal(second.justEnabled, false);
  assert.equal(second.status.kind, "ready");
});
