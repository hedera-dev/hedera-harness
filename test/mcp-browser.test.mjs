import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const {
  resolveMcpBrowser,
  isHarnessMcpServer,
  PLAYWRIGHT_MCP_PACKAGE,
  HARNESS_MCP_MARKER,
} = await import(pathToFileURL(path.resolve("dist/mcpBrowser.js")).href);
const { detectSemanticInfrastructureFailure } = await import(
  pathToFileURL(path.resolve("dist/semanticInfra.js")).href
);

test("the MCP package is pinned, never @latest", () => {
  // @latest moved the required browser build under users with no harness
  // release, failing runs only after the generator had been paid for.
  assert.match(PLAYWRIGHT_MCP_PACKAGE, /^@playwright\/mcp@\d+\.\d+\.\d+$/);
  assert.doesNotMatch(PLAYWRIGHT_MCP_PACKAGE, /latest/);
});

test("the resolved browser prefers the project's Playwright, else system Chrome", async () => {
  const root = await makeTestTempDir("mcp-browser-");
  const choice = await resolveMcpBrowser(root);

  assert.ok(choice.args.includes(PLAYWRIGHT_MCP_PACKAGE), "uses the pinned package");
  assert.ok(choice.args.includes(HARNESS_MCP_MARKER), "carries the harness marker");

  if (choice.source === "project-playwright") {
    // Tier 2 and Tier 3 must drive the same binary, or a route can render for
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

  // `--browser chromium` on its own is what forced a per-version download and
  // broke Tier 3 for anyone who had not run install-browser.
  const at = args.indexOf("--browser");
  if (args[at + 1] === "chromium") {
    assert.ok(
      args.includes("--executable-path"),
      "bundled chromium is only allowed when pointed at an existing binary",
    );
  }
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

/** Builds a failing semantic result shaped like the validator's real output. */
function semanticFailure(findings, summary) {
  return {
    passed: false,
    findings: findings.map(([id, message]) => ({ id, category: "semantic", message })),
    verdict: { summary, issues: findings.map(([id, message]) => ({ id, message })) },
  };
}

test("a missing browser is classified as infrastructure, not app defects", () => {
  // Verbatim from the run that burned three attempts repairing code that was
  // never broken.
  const real = semanticFailure(
    [
      [
        "semantic:no-browser-c1",
        "critical [C1] (/tokens): Could not verify that /tokens renders, because no browser session could be started.",
      ],
      ["semantic:no-browser-c2", "critical [C2] (/tokens): Could not verify the operation tabs."],
      ["semantic:no-browser-c3", "major [C3] (/tokens): Could not verify the connect affordance."],
    ],
    'Evaluation could not be performed: the Playwright MCP browser is not installed in this environment. Every browser_navigate call failed at browser launch with "Browser \\"chrome-for-testing\\" is not installed; expected executable at /Users/x/Library/Caches/ms-playwright/chromium-1237/...".',
  );

  assert.ok(detectSemanticInfrastructureFailure(real), "must abort rather than repair");
});

test("the raw MCP launch error alone is enough to classify", () => {
  const bare = semanticFailure(
    [
      [
        "semantic:c1",
        'browser_navigate failed: Browser "chrome-for-testing" is not installed; expected executable at /Users/x/Library/Caches/ms-playwright/chromium-1237/chrome-mac-arm64/Google Chrome for Testing',
      ],
      ["semantic:c2", "Assertion could not be checked."],
      ["semantic:c3", "Assertion could not be checked."],
    ],
    "Could not complete evaluation.",
  );

  assert.ok(
    detectSemanticInfrastructureFailure(bare),
    "classification must not depend on the agent narrating the failure well",
  );
});

test("a genuine app failure is still treated as an app defect", () => {
  const appBug = semanticFailure(
    [
      ["semantic:c1", "critical [C1] (/tokens): The token list renders an empty div with no headings."],
      ["semantic:c2", "major [C2] (/tokens): The mint tab is missing an amount input."],
      ["semantic:c3", "major [C3] (/): Header navigation does not link to /tokens."],
    ],
    "Three assertions failed against the running app.",
  );

  assert.equal(
    detectSemanticInfrastructureFailure(appBug),
    undefined,
    "repairing real defects must not be mistaken for an infrastructure abort",
  );
});
