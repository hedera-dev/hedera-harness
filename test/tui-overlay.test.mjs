import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const overlay = await import(pathToFileURL(path.resolve("dist/tui/overlay.js")).href);

test("parseCliArgs accepts tui install and uninstall", () => {
  const install = cli.parseCliArgs(["tui", "install", "D:\\my-dapp", "--keep-default", "--no-init"]);
  assert.equal(install.command, "tui");
  assert.equal(install.tuiOptions?.subcommand, "install");
  assert.equal(install.tuiOptions?.targetDir, "D:\\my-dapp");
  assert.equal(install.tuiOptions?.keepDefault, true);
  assert.equal(install.tuiOptions?.skipInit, true);
  assert.equal(install.tuiOptions?.skipInstall, undefined);

  const skipYarn = cli.parseCliArgs(["tui", "install", "./app", "--skip-install"]);
  assert.equal(skipYarn.tuiOptions?.skipInstall, true);

  const uninstall = cli.parseCliArgs(["tui", "uninstall", "./app"]);
  assert.equal(uninstall.tuiOptions?.subcommand, "uninstall");
  assert.equal(uninstall.tuiOptions?.targetDir, "./app");
});

test("parseCliArgs rejects unknown tui subcommands", () => {
  assert.throws(() => cli.parseCliArgs(["tui", "deploy"]), /install" or "uninstall"/);
});

test("printHelp documents tui install", () => {
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
  assert.match(help, /hedera-harness tui/);
  assert.match(help, /--keep-default/);
  assert.match(help, /Does not write ~\/\.config\/opencode/);
  assert.match(help, /yarn install.*no timeout/);
});

test("tui install copies overlay and tui uninstall removes it", async () => {
  const root = await makeTestTempDir("tui-overlay-");
  await writeFile(path.join(root, "package.json"), '{"name":"my-dapp","version":"1.0.0"}\n');

  const installed = await overlay.installTuiOverlay({
    subcommand: "install",
    targetDir: root,
    skipInit: true,
    skipInstall: true,
  });
  assert.ok(existsSync(path.join(root, "opencode.json")));
  assert.ok(existsSync(path.join(root, ".opencode", "agents", "hedera-generate.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "commands", "harness-run.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "plugins", "hedera-harness.js")));
  assert.ok(existsSync(path.join(root, ".opencode", "skills", "harness-playwright-e2e", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "hedera-harness.json")));
  assert.ok(existsSync(path.join(root, "AGENTS.md")));

  const config = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.equal(config.default_agent, "hedera-orchestrator");
  assert.ok(config.agent?.["hedera-orchestrator"]);
  assert.equal(config.mcp?.["hedera-docs"]?.type, "remote");
  assert.equal(config.mcp?.["hedera-docs"]?.url, overlay.HEDERA_DOCS_MCP_URL);
  assert.equal(config.mcp?.["hedera-docs"]?.enabled, true);
  assert.equal(config.mcp?.["openzeppelin-solidity"]?.type, "remote");
  assert.equal(config.mcp?.["openzeppelin-solidity"]?.url, overlay.OPENZEPPELIN_MCP_URL);
  assert.equal(config.mcp?.["openzeppelin-solidity"]?.enabled, false);
  assert.ok(config.watcher?.ignore?.some((p) => String(p).includes("node_modules")));
  assert.ok(existsSync(path.join(root, ".opencode", "skills", "harness-hedera-docs", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "skills", "harness-contracts", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "skills", "harness-tokens", "SKILL.md")));
  assert.ok(existsSync(path.join(root, ".opencode", "skills", "harness-e2e-contract", "SKILL.md")));

  const pointer = JSON.parse(await readFile(path.join(root, ".opencode", "hedera-harness.json"), "utf8"));
  assert.equal(pointer.schemaVersion, 1);
  assert.ok(pointer.harnessRoot);
  assert.ok(installed.writtenFiles.includes("opencode.json"));
  assert.match(installed.nextSteps.join("\n"), /skip-install/);

  const removed = await overlay.uninstallTuiOverlay({ subcommand: "uninstall", targetDir: root });
  assert.equal(existsSync(path.join(root, "opencode.json")), false);
  assert.equal(existsSync(path.join(root, ".opencode")), false);
  assert.equal(existsSync(path.join(root, "AGENTS.md")), false);
  assert.ok(removed.removedFiles.length > 0);
});

test("tui install merges existing opencode.json and --keep-default leaves Gentle default", async () => {
  const root = await makeTestTempDir("tui-merge-");
  await writeFile(
    path.join(root, "opencode.json"),
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      default_agent: "gentle-orchestrator",
      agent: { build: { mode: "primary" } },
      mcp: { keep: { type: "local", command: ["echo"] } },
    }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "AGENTS.md"), "# mine\n");
  await mkdir(path.join(root, ".opencode", "plugins"), { recursive: true });
  await writeFile(path.join(root, ".opencode", "plugins", "mine.js"), "export const x = 1;\n");

  await overlay.installTuiOverlay({
    subcommand: "install",
    targetDir: root,
    keepDefault: true,
    skipInit: true,
    skipInstall: true,
  });
  const config = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.equal(config.default_agent, "gentle-orchestrator");
  assert.ok(config.agent.build);
  assert.ok(config.agent["hedera-orchestrator"]);
  assert.equal(config.mcp.keep.command[0], "echo");
  assert.equal(config.mcp["hedera-docs"].url, overlay.HEDERA_DOCS_MCP_URL);

  const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /# mine/);
  assert.match(agents, /hedera-orchestrator/);

  await overlay.uninstallTuiOverlay({ subcommand: "uninstall", targetDir: root });
  assert.equal(existsSync(path.join(root, ".opencode", "plugins", "mine.js")), true);
  const leftover = JSON.parse(await readFile(path.join(root, "opencode.json"), "utf8"));
  assert.equal(leftover.default_agent, "gentle-orchestrator");
  assert.equal(leftover.agent["hedera-orchestrator"], undefined);
  assert.ok(leftover.agent.build);
  assert.equal(leftover.mcp["hedera-docs"], undefined);
  assert.equal(leftover.mcp["openzeppelin-solidity"], undefined);
  assert.equal(leftover.mcp.keep.command[0], "echo");
  const agentsAfter = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(agentsAfter, /# mine/);
  assert.doesNotMatch(agentsAfter, /hedera-harness-tui:start/);
});

test("tui install auto-inits an existing project without --no-init", async () => {
  const root = await makeTestTempDir("tui-auto-init-");
  await writeFile(path.join(root, "package.json"), '{"name":"my-dapp","version":"1.0.0"}\n');

  const installed = await overlay.installTuiOverlay({
    subcommand: "install",
    targetDir: root,
    skipSkills: true,
    skipInstall: true,
  });
  assert.equal(installed.inited, true);
  assert.ok(existsSync(path.join(root, ".harness", "spec.yaml")));
  assert.ok(existsSync(path.join(root, "opencode.json")));
  assert.ok(existsSync(path.join(root, ".opencode", "agents", "hedera-init.md")));
});

test("needsHarnessInit is true until .harness/spec.yaml exists", async () => {
  const root = await makeTestTempDir("tui-need-init-");
  assert.equal(overlay.needsHarnessInit(root), true);
  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(path.join(root, ".harness", "spec.yaml"), "name: x\n");
  assert.equal(overlay.needsHarnessInit(root), false);
});

test("tui install refuses the harness package root and ~/.config/opencode", async () => {
  await assert.rejects(
    () => overlay.installTuiOverlay({ subcommand: "install", targetDir: overlay.harnessPackageRoot() }),
    /already lives in the hedera-harness package/,
  );
  const { homedir } = await import("node:os");
  const configHome = path.join(homedir(), ".config", "opencode");
  if (!existsSync(configHome)) {
    return;
  }
  await assert.rejects(
    () => overlay.installTuiOverlay({ subcommand: "install", targetDir: configHome }),
    /Refusing to install into ~\/\.config\/opencode/,
  );
});

test("orchestrator interviews one question at a time and reshapes seed UI", async () => {
  const body = await readFile(path.resolve(".opencode", "prompts", "hedera-orchestrator.md"), "utf8");
  assert.match(body, /One `question` at a time/i);
  assert.match(body, /Never dump/i);
  assert.match(body, /scaffold is the chassis/i);
  assert.match(body, /FORBIDDEN:\*\* OpenCode bash `yarn install`/);
  assert.doesNotMatch(body, /whether `\/` \(scaffold Home \/ Debug Contracts\) \*\*stays\*\*/);
  const generate = await readFile(path.resolve(".opencode", "agents", "hedera-generate.md"), "utf8");
  assert.match(generate, /must become the interviewed dApp/);
  assert.match(generate, /Do \*\*not\*\* leave the seed Hedera landing/);
  assert.match(generate, /harness_tokens/);
  const docsSkill = await readFile(
    path.resolve(".opencode", "skills", "harness-hedera-docs", "SKILL.md"),
    "utf8",
  );
  assert.match(docsSkill, /harness_tokens/);
  const tokenSkill = await readFile(
    path.resolve(".opencode", "skills", "harness-tokens", "SKILL.md"),
    "utf8",
  );
  assert.match(tokenSkill, /0x0000000000000000000000000000000000068cda/);
  assert.match(tokenSkill, /token=lookup/);
});

test("GENERATE stamps the e2e contract and EVALUATE drives it on any app", async () => {
  const generate = await readFile(path.resolve(".opencode", "agents", "hedera-generate.md"), "utf8");
  assert.match(generate, /harness_e2e_contract action=set/);
  assert.match(generate, /harness-e2e-contract/);

  const evaluate = await readFile(path.resolve(".opencode", "agents", "hedera-evaluate.md"), "utf8");
  assert.match(evaluate, /harness_e2e_contract/);
  assert.match(evaluate, /e2e-contract-missing/);
  assert.match(evaluate, /never\*\* ask the human to close Chrome/i);
  assert.match(evaluate, /beta/);
  // The payments-only carve-out is gone: the contract makes E2E all-terrain.
  assert.doesNotMatch(evaluate, /it only knows `pay-amount`/);

  const skill = await readFile(
    path.resolve(".opencode", "skills", "harness-e2e-contract", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /\.harness\/e2e\.json/);
  assert.match(skill, /confirmations=2/);

  const plugin = await readFile(path.resolve(".opencode", "plugins", "hedera-harness.js"), "utf8");
  assert.match(plugin, /harness_e2e_contract: tool\(/);
  assert.match(plugin, /e2eContract\.js/);

  const readme = await readFile(path.resolve("README.md"), "utf8");
  assert.match(readme, /Beta: persistent test wallet/);
  assert.match(readme, /not the release done bar/);
  const orchestrator = await readFile(path.resolve(".opencode", "prompts", "hedera-orchestrator.md"), "utf8");
  assert.match(orchestrator, /beta — persistent test wallet/i);
});

test("stage agents allow obligated yarn commands without a permission prompt", async () => {
  const agentsDir = path.resolve(".opencode", "agents");
  const yarnAgents = [
    "hedera-assert",
    "hedera-generate",
    "hedera-smoke",
    "hedera-init",
    "hedera-evaluate",
    "hedera-local",
  ];
  for (const name of yarnAgents) {
    const body = await readFile(path.join(agentsDir, `${name}.md`), "utf8");
    assert.match(body, /"yarn \*": allow/, `${name} must allow yarn *`);
    const star = body.indexOf('"*": ask');
    const yarn = body.indexOf('"yarn *": allow');
    assert.ok(star >= 0 && yarn > star, `${name} must put *: ask before yarn *`);
  }
  const assertMd = await readFile(path.join(agentsDir, "hedera-assert.md"), "utf8");
  assert.match(assertMd, /"yarn next:dev\*": deny/);
  assert.match(assertMd, /"tail \*": allow/);
  const smokeMd = await readFile(path.join(agentsDir, "hedera-smoke.md"), "utf8");
  assert.match(smokeMd, /"yarn next:dev\*": deny/);
  const initMd = await readFile(path.join(agentsDir, "hedera-init.md"), "utf8");
  assert.match(initMd, /"yarn install\*": deny/);
  const orchestratorJson = JSON.parse(await readFile(path.resolve("opencode.json"), "utf8"));
  assert.equal(orchestratorJson.agent["hedera-orchestrator"].permission.bash["yarn install*"], "deny");
});
