import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const {
  resolveMcpBrowser,
  mcpArgsForBrowser,
  playwrightLaunchOptionsForBrowser,
  isHarnessMcpServer,
  PLAYWRIGHT_MCP_PACKAGE,
  HARNESS_MCP_MARKER,
} = await import(pathToFileURL(path.resolve("dist/mcpBrowser.js")).href);
const { detectEvalInfrastructureFailure } = await import(
  pathToFileURL(path.resolve("dist/evalInfra.js")).href
);

test("the MCP package is pinned, never @latest", () => {
  // @latest moved the required browser build under users with no harness
  // release, failing runs only after the generator had been paid for.
  assert.match(PLAYWRIGHT_MCP_PACKAGE, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  assert.doesNotMatch(PLAYWRIGHT_MCP_PACKAGE, /latest/);
});

test("the resolved browser prefers Playwright Chromium, else system Chrome", async () => {
  const root = await makeTestTempDir("mcp-browser-");
  const choice = await resolveMcpBrowser(root);

  assert.ok(choice.args.includes(PLAYWRIGHT_MCP_PACKAGE), "uses the pinned package");
  assert.ok(choice.args.includes(HARNESS_MCP_MARKER), "carries the harness marker");

  if (choice.source === "project-playwright") {
    // SMOKE and EVALUATE must drive the same binary, or a route can render for
    // one and not the other.
    assert.ok(choice.executablePath, "records the shared browser path");
    const at = choice.args.indexOf("--executable-path");
    assert.notEqual(at, -1, "points MCP at that browser");
    assert.equal(choice.args[at + 1], choice.executablePath);
  } else {
    assert.equal(choice.source, "system-chrome");
    const at = choice.args.indexOf("--browser");
    assert.equal(choice.args[at + 1], "chrome", "falls back to a browser needing no download");
  }
});

test("no resolution asks for a browser that would need its own download", async () => {
  const root = await makeTestTempDir("mcp-nodownload-");
  const { args } = await resolveMcpBrowser(root);

  // The MCP CLI documents chrome/firefox/webkit/msedge as --browser values.
  // Playwright-managed Chromium is selected by its existing executable path,
  // not by passing the undocumented `--browser chromium` value.
  const at = args.indexOf("--browser");
  assert.notEqual(args[at + 1], "chromium", "must not pass an undocumented MCP browser value");

  if (args.includes("--executable-path")) {
    assert.equal(at, -1, "an explicit Playwright browser path needs no channel override");
  } else {
    assert.equal(args[at + 1], "chrome", "the zero-download fallback is system Chrome");
  }
});

test("a Playwright Chromium browser is selected by executable path, not an undocumented channel", () => {
  const args = mcpArgsForBrowser({
    source: "project-playwright",
    executablePath: "/existing/playwright/chromium",
    detail: "fixture",
  });

  assert.ok(args.includes("--executable-path"));
  assert.ok(args.includes("/existing/playwright/chromium"));
  assert.equal(args.indexOf("--browser"), -1);
});

test("SMOKE launches the same browser choice as EVALUATE", () => {
  assert.deepEqual(
    playwrightLaunchOptionsForBrowser({
      source: "project-playwright",
      executablePath: "/existing/playwright/chromium",
    }),
    {
      headless: true,
      executablePath: "/existing/playwright/chromium",
    },
  );
  assert.deepEqual(
    playwrightLaunchOptionsForBrowser({ source: "system-chrome" }),
    {
      headless: true,
      channel: "chrome",
    },
  );
});

test("isHarnessMcpServer only matches entries the harness wrote", async () => {
  const root = await makeTestTempDir("mcp-marker-");
  const ours = { command: "npx", args: (await resolveMcpBrowser(root)).args };
  assert.equal(isHarnessMcpServer(ours), true);

  // The shape a user writes by hand — same server name, must never be stripped.
  assert.equal(isHarnessMcpServer({ command: "npx", args: ["@playwright/mcp@latest"] }), false);
  assert.equal(
    isHarnessMcpServer({ command: "npx", args: [PLAYWRIGHT_MCP_PACKAGE] }),
    false,
    "the pinned spec alone is not proof we wrote it",
  );
  assert.equal(isHarnessMcpServer({ command: "docker", args: ["run", "mcp"] }), false);
  assert.equal(isHarnessMcpServer(undefined), false);
  assert.equal(isHarnessMcpServer({}), false);
});

test("the MCP config directs session files away from the project", async () => {
  const root = await makeTestTempDir("mcp-outdir-");
  const configPath = path.join(root, ".harness", "runs", "r1", "mcp", "playwright.json");

  const { writePlaywrightMcpConfig } = await import(
    pathToFileURL(path.resolve("dist/mcpBrowser.js")).href
  );
  await writePlaywrightMcpConfig(configPath, root);

  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const args = config.mcpServers.playwright.args;

  // Left to itself the server writes `.playwright-mcp/` into the workspace,
  // and the next run refuses to start on a dirty tree.
  const at = args.indexOf("--output-dir");
  assert.notEqual(at, -1, "must pin an output directory");
  assert.ok(
    args[at + 1].startsWith(path.join(root, ".harness", "runs")),
    `output must stay inside the run directory, got ${args[at + 1]}`,
  );
});

/** Builds a failing evaluation result shaped like the validator's real output. */
function evalFailure(findings, summary) {
  return {
    passed: false,
    findings: findings.map(([id, message]) => ({ id, category: "eval", message })),
    verdict: { summary, issues: findings.map(([id, message]) => ({ id, message })) },
  };
}

test("a missing browser is classified as infrastructure, not app defects", () => {
  // Verbatim from the run that burned three attempts repairing code that was
  // never broken.
  const real = evalFailure(
    [
      [
        "eval:no-browser-e1",
        "critical [E1] (/tokens): Could not verify that /tokens renders, because no browser session could be started.",
      ],
      ["eval:no-browser-e2", "critical [E2] (/tokens): Could not verify the operation tabs."],
      ["eval:no-browser-e3", "major [E3] (/tokens): Could not verify the connect affordance."],
    ],
    'Evaluation could not be performed: the Playwright MCP browser is not installed in this environment. Every browser_navigate call failed at browser launch with "Browser \\"chrome-for-testing\\" is not installed; expected executable at /Users/x/Library/Caches/ms-playwright/chromium-1237/...".',
  );

  assert.ok(detectEvalInfrastructureFailure(real), "must abort rather than repair");
});

test("the raw MCP launch error alone is enough to classify", () => {
  const bare = evalFailure(
    [
      [
        "eval:e1",
        'browser_navigate failed: Browser "chrome-for-testing" is not installed; expected executable at /Users/x/Library/Caches/ms-playwright/chromium-1237/chrome-mac-arm64/Google Chrome for Testing',
      ],
      ["eval:e2", "Assertion could not be checked."],
      ["eval:e3", "Assertion could not be checked."],
    ],
    "Could not complete evaluation.",
  );

  assert.ok(
    detectEvalInfrastructureFailure(bare),
    "classification must not depend on the agent narrating the failure well",
  );
});

test("a genuine app failure is still treated as an app defect", () => {
  const appBug = evalFailure(
    [
      ["eval:e1", "critical [E1] (/tokens): The token list renders an empty div with no headings."],
      ["eval:e2", "major [E2] (/tokens): The mint tab is missing an amount input."],
      ["eval:e3", "major [E3] (/): Header navigation does not link to /tokens."],
    ],
    "Three assertions failed against the running app.",
  );

  assert.equal(
    detectEvalInfrastructureFailure(appBug),
    undefined,
    "repairing real defects must not be mistaken for an infrastructure abort",
  );
});
