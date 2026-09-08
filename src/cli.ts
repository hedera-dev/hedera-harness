import { runInit } from "./initRunner.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { formatMigrationResult, migrateSpecFile } from "./migrate.js";
import { runHarness, validateSemanticWorkspace, validateWorkspace } from "./runner.js";
import type {
  CliOptions,
  HarnessCommand,
  InitCliOptions,
  McpCliOptions,
  McpSubcommand,
  ParsedCli,
  TasksCliOptions,
  TasksSubcommand,
  TuiCliOptions,
  TuiSubcommand,
  WalletCliOptions,
  WalletSessionAction,
  WalletSubcommand,
  ServeCliOptions,
  ServeSubcommand,
} from "./types.js";
import { printTuiHelp, runTuiCommand } from "./tui/overlay.js";
import { inspectTasks, formatTasksStatus, markTaskDone } from "./harnessTasks.js";
import { formatDevServeReport, runDevServe } from "./devServe.js";
import {
  inspectPlaywrightMcp,
  formatPlaywrightMcpStatus,
  enablePlaywrightMcp,
  installPlaywrightMcp,
} from "./playwrightMcp.js";
import { resolveAppWorkspace } from "./appWorkspace.js";
import { runWalletProvision, runWalletStatus } from "./walletCli.js";

const COMMANDS = new Set<HarnessCommand>([
  "init",
  "run",
  "doctor",
  "migrate",
  "validate",
  "validate-semantic",
  "tui",
  "wallet",
  "mcp",
  "tasks",
  "serve",
]);
const TUI_SUBCOMMANDS = new Set<TuiSubcommand>(["install", "uninstall"]);
const WALLET_SUBCOMMANDS = new Set<WalletSubcommand>(["status", "provision", "browser", "e2e", "session"]);
const WALLET_SESSION_ACTIONS = new Set<WalletSessionAction>([
  "start",
  "stop",
  "status",
  "serve",
  "snapshot",
  "click",
  "fill",
  "goto",
  "mm",
  "press",
]);
const MCP_SUBCOMMANDS = new Set<McpSubcommand>(["status", "enable", "install"]);
const TASKS_SUBCOMMANDS = new Set<TasksSubcommand>(["status", "done"]);
const SERVE_SUBCOMMANDS = new Set<ServeSubcommand>(["start", "stop", "status"]);
const DEFAULT_RUN_SPEC = ".harness/spec.yaml";

export function parseCliArgs(argv: string[]): ParsedCli {
  const [rawCommand, ...rest] = argv;

  if (!rawCommand || !isHarnessCommand(rawCommand)) {
    throw new Error(
      `Expected command "init", "run", "doctor", "migrate", "validate", "validate-semantic", "tui", "wallet", "mcp", "tasks", or "serve".`,
    );
  }

  if (rawCommand === "init") {
    return {
      command: "init",
      options: { specPath: DEFAULT_RUN_SPEC },
      initOptions: parseInitOptions(rest),
    };
  }

  if (rawCommand === "tui") {
    return {
      command: "tui",
      options: { specPath: DEFAULT_RUN_SPEC },
      tuiOptions: parseTuiOptions(rest),
    };
  }

  if (rawCommand === "wallet") {
    return {
      command: "wallet",
      options: { specPath: DEFAULT_RUN_SPEC },
      walletOptions: parseWalletOptions(rest),
    };
  }

  if (rawCommand === "mcp") {
    return {
      command: "mcp",
      options: { specPath: DEFAULT_RUN_SPEC },
      mcpOptions: parseMcpOptions(rest),
    };
  }

  if (rawCommand === "tasks") {
    return {
      command: "tasks",
      options: { specPath: DEFAULT_RUN_SPEC },
      tasksOptions: parseTasksOptions(rest),
    };
  }

  if (rawCommand === "serve") {
    return {
      command: "serve",
      options: { specPath: DEFAULT_RUN_SPEC },
      serveOptions: parseServeOptions(rest),
    };
  }

  const { specPath, flagArgs } = takeSpecPath(rawCommand, rest);
  const options = parseOptions(rawCommand, specPath, flagArgs);
  return {
    command: rawCommand,
    options,
  };
}

export function printHelp(): void {
  console.log(`hedera-harness

Usage:
  hedera-harness init [target-dir] [--repo <url>] [--ref <branch>] [--template <name>] [--skip-install]
  hedera-harness run [spec] [--max-attempts <count>] [--new] [--continue <branch>]
  hedera-harness doctor [spec] [--workspace <path>] [--recipe-only]
  hedera-harness migrate [spec] [--dry-run]
  hedera-harness validate [spec] [--workspace <path>]
  hedera-harness validate-semantic [spec] [--workspace <path>]
  hedera-harness tui <install|uninstall> [target-dir] [--keep-default] [--no-init] [--skip-install]
  hedera-harness wallet <status|provision|browser|e2e|session> [--workspace <dir>] [--no-open] [--port <n>]
  hedera-harness mcp <status|enable|install> [--workspace <dir>]
  hedera-harness tasks <status|done> [--workspace <dir>] [--id <T1>]
  hedera-harness serve <start|stop|status> [--workspace <dir>]

Examples:
  hedera-harness init my-app
  hedera-harness init my-app --template hedera-demo
  hedera-harness init                    # adopt the harness in the current project
  hedera-harness run
  hedera-harness run .harness/spec.yaml --max-attempts 3
  hedera-harness run .harness/spec.yaml --new
  hedera-harness run .harness/spec.yaml --continue harness/run-my-feature-abc123
  hedera-harness doctor
  hedera-harness migrate --dry-run
  hedera-harness validate
  hedera-harness validate .harness/spec.yaml
  hedera-harness validate-semantic .harness/spec.yaml
  hedera-harness tui install
  hedera-harness tui install ./my-dapp --keep-default
  hedera-harness wallet status
  hedera-harness wallet provision
  hedera-harness mcp status

Project-centric run notes:
  - Workspace is the current directory (cwd). Bootstrap with \`init\` first (or use an existing app with .harness/).
  - On a matching harness/run-* (or legacy harness/extend-*) branch + same spec, continues automatically.
  - On a normal branch, or when the spec differs, creates harness/run-<slug>-<id>.
  - --new forces a fresh harness branch; --continue <branch> checks out that branch and resumes.
  - Does not auto-stash, push, open a PR, merge, or delete branches.

OpenCode TUI notes:
  - \`tui install\` scaffolds the target if \`.harness/spec.yaml\` is missing (clone/adopt, no yarn), then copies the overlay. Yarn runs later in OpenCode INIT.
  - Does not write ~/.config/opencode (Gentle stays global).
  - See \`hedera-harness tui --help\`.
  - \`wallet provision\` opens a local 127.0.0.1 page for a TESTNET MetaMask key+password. Never paste keys in chat. \`wallet browser\` loads MetaMask via dappwright into a persistent Chromium profile under .harness/wallet/ (first run imports; later runs unlock). \`wallet session start\` keeps that browser alive and exposes snapshot/click/fill on the dapp tab (not Playwright MCP vanilla Chrome). \`wallet e2e\` is the one-shot scripted send.
  - \`mcp status|enable|install\` inspects Playwright MCP in project/user opencode.json. Install writes the project file only (never ~/.config/opencode unless the entry already lives there). New sessions pick up MCP tools.
  - \`tasks status\` reads .harness/tasks.md (T1, T2… work units) and \`contracts=none|solidity\` (Hardhat skip vs run).
  - \`serve start|stop|status\` tracks one \`yarn next:dev\` in \`.harness/dev-server.json\`. Reuses it if CSS is healthy; otherwise kills leftover nohup/orphan next:dev for this app before starting. Do not \`nohup yarn next:dev\`.`);
}

export async function runCli(parsed: ParsedCli): Promise<void> {
  if (parsed.command === "tui") {
    if (!parsed.tuiOptions) {
      throw new Error("Internal error: tui command missing tuiOptions");
    }
    await runTuiCommand(parsed.tuiOptions);
    return;
  }

  if (parsed.command === "wallet") {
    if (!parsed.walletOptions) {
      throw new Error("Internal error: wallet command missing walletOptions");
    }
    await runWalletCommand(parsed.walletOptions);
    return;
  }

  if (parsed.command === "mcp") {
    if (!parsed.mcpOptions) {
      throw new Error("Internal error: mcp command missing mcpOptions");
    }
    await runMcpCommand(parsed.mcpOptions);
    return;
  }

  if (parsed.command === "tasks") {
    if (!parsed.tasksOptions) {
      throw new Error("Internal error: tasks command missing tasksOptions");
    }
    await runTasksCommand(parsed.tasksOptions);
    return;
  }

  if (parsed.command === "serve") {
    if (!parsed.serveOptions) {
      throw new Error("Internal error: serve command missing serveOptions");
    }
    await runServeCommand(parsed.serveOptions);
    return;
  }

  if (parsed.command === "init") {
    const result = await runInit(parsed.initOptions ?? {});
    console.log(
      [
        result.mode === "seeded"
          ? "Harness project initialized"
          : "Harness adopted in existing project",
        `target=${result.targetDir}`,
        result.mode === "seeded" ? `seed=${result.repo}@${result.ref}` : undefined,
        result.mode === "seeded" && result.commitSha
          ? `git=${result.commitSha.slice(0, 8)} (fresh repo on main, no remote)`
          : undefined,
        `recipe=${result.harnessDir}/`,
        `filesWritten=${result.writtenFiles.length}`,
        result.skippedFiles.length > 0
          ? `filesKept=${result.skippedFiles.length} (${result.skippedFiles.join(", ")})`
          : undefined,
        `skillsVendored=${result.vendoredSkillCount}`,
        "",
        "Next steps:",
        ...result.nextSteps.map(step => `  ${step}`),
        "",
        "Tip: authoring skills (create/review harness-spec) ship via the hedera-skills",
        "marketplace plugin — they are not copied into the project. Generator skills for",
        "`run` are still vendored under .harness/skills/ from skills-index.json.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    );
    return;
  }

  if (parsed.command === "doctor") {
    const report = await runDoctor(parsed.options, { recipeOnly: parsed.options.recipeOnly });
    console.log(formatDoctorReport(report));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === "migrate") {
    const result = await migrateSpecFile(parsed.options.specPath, {
      dryRun: parsed.options.dryRun,
    });
    console.log(formatMigrationResult(result, Boolean(parsed.options.dryRun)));
    return;
  }

  if (parsed.command === "validate") {
    const validation = await validateWorkspace(parsed.options);
    console.log(
      [
        `Validation finished`,
        `passed=${validation.passed}`,
        `findings=${validation.findings.length}`,
        validation.playwrightGate
          ? `playwrightGate=${validation.playwrightGate.passed} routes=${validation.playwrightGate.routes.length}`
          : undefined,
        ...validation.findings.map(finding => `- ${finding.message}`),
        ...validation.commandResults.map(
          result => `command ${result.command} exit=${result.exitCode} durationMs=${result.durationMs}`,
        ),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
    if (!validation.passed) {
      process.exitCode = 1;
    }
    return;
  }

  if (parsed.command === "validate-semantic") {
    const result = await validateSemanticWorkspace(parsed.options);
    console.log(
      [
        `Semantic validation finished`,
        `passed=${result.passed}`,
        `findings=${result.findings.length}`,
        `durationMs=${result.durationMs}`,
        result.infrastructureFailure
          ? `infrastructureFailure=true reason=${result.infrastructureFailureReason}`
          : undefined,
        result.verdict?.summary ? `summary=${result.verdict.summary}` : undefined,
        ...result.findings.map(finding => `- [${finding.category}] ${finding.message}`),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
    );
    if (!result.passed) {
      process.exitCode = 1;
    }
    return;
  }

  const { report, outroLines } = await runHarness(parsed.options);
  console.log(outroLines.join("\n"));

  if (!report.passed) {
    process.exitCode = 1;
  }
}

function takeSpecPath(
  command: HarnessCommand,
  args: string[],
): { specPath: string; flagArgs: string[] } {
  const first = args[0];
  if (first && !first.startsWith("-")) {
    return { specPath: first, flagArgs: args.slice(1) };
  }

  if (
    command === "run" ||
    command === "doctor" ||
    command === "migrate" ||
    command === "validate" ||
    command === "validate-semantic"
  ) {
    return { specPath: DEFAULT_RUN_SPEC, flagArgs: args };
  }

  throw new Error(`Expected a template spec path.`);
}

function parseInitOptions(args: string[]): InitCliOptions {
  const options: InitCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-") && options.targetDir === undefined) {
      options.targetDir = arg;
      continue;
    }
    switch (arg) {
      case "--repo":
        options.repo = readValue(args, ++index, arg);
        break;
      case "--ref":
        options.ref = readValue(args, ++index, arg);
        break;
      case "--template":
        options.template = readValue(args, ++index, arg);
        break;
      case "--skip-install":
        options.skipInstall = true;
        break;
      case "--skills":
        options.provisionSkills = readValue(args, ++index, arg)
          .split(",")
          .map(value => value.trim())
          .filter(Boolean);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exitCode = 0;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseTuiOptions(args: string[]): TuiCliOptions {
  const [rawSubcommand, ...rest] = args;
  if (!rawSubcommand || rawSubcommand === "--help" || rawSubcommand === "-h") {
    printTuiHelp();
    process.exit(0);
  }
  if (!TUI_SUBCOMMANDS.has(rawSubcommand as TuiSubcommand)) {
    throw new Error(
      `Expected tui subcommand "install" or "uninstall" (got ${JSON.stringify(rawSubcommand)}).`,
    );
  }

  const options: TuiCliOptions = {
    subcommand: rawSubcommand as TuiSubcommand,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg && !arg.startsWith("-") && options.targetDir === undefined) {
      options.targetDir = arg;
      continue;
    }
    switch (arg) {
      case "--keep-default":
        options.keepDefault = true;
        break;
      case "--no-init":
        options.skipInit = true;
        break;
      case "--skip-install":
        options.skipInstall = true;
        break;
      case "--help":
      case "-h":
        printTuiHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown tui option: ${arg}`);
    }
  }

  return options;
}

function parseWalletOptions(args: string[]): WalletCliOptions {
  const [rawSubcommand, ...rest] = args;
  if (!rawSubcommand || rawSubcommand === "--help" || rawSubcommand === "-h") {
    throw new Error('Expected wallet subcommand "status", "provision", "browser", "e2e", or "session".');
  }
  if (!WALLET_SUBCOMMANDS.has(rawSubcommand as WalletSubcommand)) {
    throw new Error(
      `Expected wallet subcommand "status", "provision", "browser", "e2e", or "session" (got ${JSON.stringify(rawSubcommand)}).`,
    );
  }

  const options: WalletCliOptions = {
    subcommand: rawSubcommand as WalletSubcommand,
    open: true,
  };

  let flags = rest;
  if (options.subcommand === "session") {
    const action = rest[0];
    if (!action || action.startsWith("--")) {
      options.sessionAction = "status";
    } else {
      if (!WALLET_SESSION_ACTIONS.has(action as WalletSessionAction)) {
        throw new Error(
          `Expected wallet session action "start", "stop", "status", "snapshot", "click", "fill", "goto", "mm", or "press" (got ${JSON.stringify(action)}).`,
        );
      }
      options.sessionAction = action as WalletSessionAction;
      flags = rest.slice(1);
    }
  }

  for (let index = 0; index < flags.length; index += 1) {
    const arg = flags[index];
    switch (arg) {
      case "--workspace":
        options.workspace = readValue(flags, ++index, arg);
        break;
      case "--no-open":
        options.open = false;
        break;
      case "--port":
        options.port = readPositiveInteger(flags, ++index, arg);
        break;
      case "--url":
        options.url = readValue(flags, ++index, arg);
        break;
      case "--amount":
        options.amount = readValue(flags, ++index, arg);
        break;
      case "--to":
        options.to = readValue(flags, ++index, arg);
        break;
      case "--ref":
        options.ref = readValue(flags, ++index, arg);
        break;
      case "--testid":
      case "--test-id":
        options.testId = readValue(flags, ++index, arg);
        break;
      case "--role":
        options.role = readValue(flags, ++index, arg);
        break;
      case "--name":
        options.name = readValue(flags, ++index, arg);
        break;
      case "--text":
        options.text = readValue(flags, ++index, arg);
        break;
      case "--value":
        options.value = readValue(flags, ++index, arg);
        break;
      case "--action":
        options.mmAction = readValue(flags, ++index, arg);
        break;
      case "--key":
        options.key = readValue(flags, ++index, arg);
        break;
      default:
        throw new Error(`Unknown wallet option: ${arg}`);
    }
  }

  return options;
}

async function runWalletCommand(options: WalletCliOptions): Promise<void> {
  const workspace = resolveAppWorkspace(options.workspace ?? process.cwd());
  if (options.subcommand === "status") {
    console.log(await runWalletStatus(workspace));
    return;
  }
  if (options.subcommand === "provision") {
    console.log(
      await runWalletProvision(workspace, {
        open: options.open !== false,
        port: options.port,
      }),
    );
    return;
  }
  if (options.subcommand === "e2e") {
    const { runWalletE2e } = await import("./walletE2e.js");
    console.log(await runWalletE2e(workspace, options.url, { amount: options.amount, to: options.to }));
    return;
  }
  if (options.subcommand === "session") {
    const { runWalletSession } = await import("./walletSession.js");
    console.log(
      await runWalletSession(workspace, options.sessionAction ?? "status", {
        url: options.url,
        port: options.port,
        ref: options.ref,
        testId: options.testId,
        role: options.role,
        name: options.name,
        text: options.text,
        value: options.value,
        mmAction: options.mmAction,
        key: options.key,
      }),
    );
    return;
  }
  const { runWalletBrowser } = await import("./walletBrowser.js");
  await runWalletBrowser(workspace);
}

function parseMcpOptions(args: string[]): McpCliOptions {
  const [rawSubcommand, ...rest] = args;
  if (!rawSubcommand || rawSubcommand === "--help" || rawSubcommand === "-h") {
    throw new Error('Expected mcp subcommand "status", "enable", or "install".');
  }
  if (!MCP_SUBCOMMANDS.has(rawSubcommand as McpSubcommand)) {
    throw new Error(
      `Expected mcp subcommand "status", "enable", or "install" (got ${JSON.stringify(rawSubcommand)}).`,
    );
  }
  const options: McpCliOptions = { subcommand: rawSubcommand as McpSubcommand };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--workspace":
        options.workspace = readValue(rest, ++index, arg);
        break;
      default:
        throw new Error(`Unknown mcp option: ${arg}`);
    }
  }
  return options;
}

async function runMcpCommand(options: McpCliOptions): Promise<void> {
  const workspace = options.workspace ?? process.cwd();
  if (options.subcommand === "enable") {
    console.log(formatPlaywrightMcpStatus(enablePlaywrightMcp(workspace)));
    return;
  }
  if (options.subcommand === "install") {
    console.log(formatPlaywrightMcpStatus(installPlaywrightMcp(workspace)));
    return;
  }
  console.log(formatPlaywrightMcpStatus(inspectPlaywrightMcp(workspace)));
}

function parseTasksOptions(args: string[]): TasksCliOptions {
  const [rawSubcommand, ...rest] = args;
  if (!rawSubcommand || rawSubcommand === "--help" || rawSubcommand === "-h") {
    throw new Error('Expected tasks subcommand "status" or "done".');
  }
  if (!TASKS_SUBCOMMANDS.has(rawSubcommand as TasksSubcommand)) {
    throw new Error(
      `Expected tasks subcommand "status" or "done" (got ${JSON.stringify(rawSubcommand)}).`,
    );
  }
  const options: TasksCliOptions = { subcommand: rawSubcommand as TasksSubcommand };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--workspace":
        options.workspace = readValue(rest, ++index, arg);
        break;
      case "--id":
        options.taskId = readValue(rest, ++index, arg);
        break;
      default:
        throw new Error(`Unknown tasks option: ${arg}`);
    }
  }
  return options;
}

async function runTasksCommand(options: TasksCliOptions): Promise<void> {
  const workspace = options.workspace ?? process.cwd();
  if (options.subcommand === "done") {
    if (!options.taskId) {
      throw new Error("Expected --id <T1> after tasks done.");
    }
    console.log(formatTasksStatus(markTaskDone(workspace, options.taskId)));
    return;
  }
  console.log(formatTasksStatus(inspectTasks(workspace)));
}

function parseServeOptions(args: string[]): ServeCliOptions {
  const [rawSubcommand, ...rest] = args;
  if (!rawSubcommand || rawSubcommand === "--help" || rawSubcommand === "-h") {
    throw new Error('Expected serve subcommand "start", "stop", or "status".');
  }
  if (!SERVE_SUBCOMMANDS.has(rawSubcommand as ServeSubcommand)) {
    throw new Error(
      `Expected serve subcommand "start", "stop", or "status" (got ${JSON.stringify(rawSubcommand)}).`,
    );
  }
  const options: ServeCliOptions = { subcommand: rawSubcommand as ServeSubcommand };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--workspace":
        options.workspace = readValue(rest, ++index, arg);
        break;
      default:
        throw new Error(`Unknown serve option: ${arg}`);
    }
  }
  return options;
}

async function runServeCommand(options: ServeCliOptions): Promise<void> {
  const workspace = options.workspace ?? process.cwd();
  console.log(formatDevServeReport(await runDevServe(workspace, options.subcommand)));
}

function parseOptions(command: HarnessCommand, specPath: string, args: string[]): CliOptions {
  const options: CliOptions = { specPath };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--max-attempts":
        options.maxAttempts = readPositiveInteger(args, ++index, arg);
        break;
      case "--recipe-only":
        if (command !== "doctor") {
          throw new Error(`${arg} is only valid for doctor.`);
        }
        options.recipeOnly = true;
        break;
      case "--dry-run":
        if (command !== "migrate") {
          throw new Error(`${arg} is only valid for migrate.`);
        }
        options.dryRun = true;
        break;
      case "--workspace":
        options.workspacePath = readValue(args, ++index, arg);
        break;
      case "--new":
        if (command !== "run") {
          throw new Error(`${arg} is only valid for run.`);
        }
        options.forceNew = true;
        break;
      case "--continue":
        if (command !== "run") {
          throw new Error(`${arg} is only valid for run.`);
        }
        options.continueBranch = readValue(args, ++index, arg);
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exitCode = 0;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.forceNew && options.continueBranch) {
    throw new Error("Cannot pass both --new and --continue.");
  }

  return options;
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected a value after ${flag}.`);
  }
  return value;
}

function readPositiveInteger(args: string[], index: number, flag: string): number {
  const raw = readValue(args, index, flag);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer after ${flag}.`);
  }
  return value;
}

function isHarnessCommand(value: string): value is HarnessCommand {
  return COMMANDS.has(value as HarnessCommand);
}
