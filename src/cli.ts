import { runExtend } from "./extendRunner.js";
import { runInit } from "./initRunner.js";
import { runHarness, validateSemanticWorkspace, validateWorkspace } from "./runner.js";
import type { CliOptions, HarnessCommand, InitCliOptions, ParsedCli } from "./types.js";

const COMMANDS = new Set<HarnessCommand>(["init", "run", "extend", "validate", "validate-semantic"]);
const DEFAULT_RUN_SPEC = ".harness/spec.yaml";

export function parseCliArgs(argv: string[]): ParsedCli {
  const [rawCommand, ...rest] = argv;

  if (!rawCommand || !isHarnessCommand(rawCommand)) {
    throw new Error(
      `Expected command "init", "run", "extend", "validate", or "validate-semantic".`,
    );
  }

  if (rawCommand === "init") {
    return {
      command: "init",
      options: { specPath: DEFAULT_RUN_SPEC },
      initOptions: parseInitOptions(rest),
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
  hedera-harness init [target-dir] [--repo <url>] [--ref <branch>] [--template <branch>] [--skip-install]
  hedera-harness run [spec] [--max-attempts <count>] [--new] [--continue <branch>]
  hedera-harness extend [spec] [--max-attempts <count>] [--new] [--continue <branch>]
  hedera-harness validate <spec> --workspace <path>
  hedera-harness validate-semantic <spec> --workspace <path>

Examples:
  hedera-harness init my-app
  hedera-harness init my-app --ref main
  hedera-harness run
  hedera-harness run .harness/spec.yaml --max-attempts 3
  hedera-harness run .harness/spec.yaml --new
  hedera-harness run .harness/spec.yaml --continue harness/run-my-feature-abc123
  hedera-harness validate .harness/spec.yaml --workspace .
  hedera-harness validate-semantic .harness/spec.yaml --workspace .

Project-centric run notes:
  - Workspace is the current directory (cwd). Bootstrap with \`init\` first (or use an existing app with .harness/).
  - On a matching harness/run-* (or legacy harness/extend-*) branch + same spec, continues automatically.
  - On a normal branch, or when the spec differs, creates harness/run-<slug>-<id>.
  - --new forces a fresh harness branch; --continue <branch> checks out that branch and resumes.
  - Does not auto-stash, push, open a PR, merge, or delete branches.

Deprecated:
  - \`extend\` is an alias for \`run\` (prints a warning). Prefer \`hedera-harness run\`.`);
}

export async function runCli(parsed: ParsedCli): Promise<void> {
  if (parsed.command === "init") {
    const result = await runInit(parsed.initOptions ?? {});
    console.log(
      [
        "Harness project initialized",
        `target=${result.targetDir}`,
        `seed=${result.repo}@${result.ref} (${result.commitSha.slice(0, 8)})`,
        `harness=${result.harnessDir}`,
        `skillsVendored=${result.vendoredSkillCount}`,
        `filesWritten=${result.writtenFiles.length}`,
        "",
        "Next steps:",
        ...result.nextSteps.map(step => `  ${step}`),
        "",
        "Tip: authoring skills (create/review harness-spec) ship via the hedera-skills",
        "marketplace plugin — they are not copied into the project. Generator skills for",
        "`run` are still vendored under .harness/skills/ from skills-index.json.",
      ].join("\n"),
    );
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

  if (parsed.command === "extend") {
    console.warn(
      'Warning: `extend` is deprecated; use `hedera-harness run` (same project-centric behavior).',
    );
  }

  // `run` and deprecated `extend` share the project-centric in-place loop.
  const { report, outroLines } = await runHarness(parsed.options);
  const lines = [...outroLines];

  if (report.passed && !report.blindIntegrity.passed) {
    lines.push(
      "",
      `WARNING: validation passed but oracle audit detected peeking (${report.blindIntegrity.findings.length} finding(s))`,
    );
  }

  console.log(lines.join("\n"));

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

  if (command === "run" || command === "extend") {
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

function parseOptions(command: HarnessCommand, specPath: string, args: string[]): CliOptions {
  const options: CliOptions = { specPath };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--max-attempts":
        options.maxAttempts = readPositiveInteger(args, ++index, arg);
        break;
      case "--workspace":
        options.workspacePath = readValue(args, ++index, arg);
        break;
      case "--new":
        if (command !== "run" && command !== "extend") {
          throw new Error(`${arg} is only valid for run/extend.`);
        }
        options.forceNew = true;
        break;
      case "--continue": {
        if (command !== "run" && command !== "extend") {
          throw new Error(`${arg} is only valid for run/extend.`);
        }
        const value = readValue(args, ++index, arg);
        // Branch-based continue (project-centric). Directory paths still accepted
        // for validate tooling / legacy isolated layouts via continueRunDirectory.
        if (value.includes("/") && !value.startsWith("harness/")) {
          // Could be a run directory (legacy) or a branch like feature/foo.
          // Prefer branch when it looks like harness/*; otherwise keep legacy dir.
          if (value.startsWith("runs/") || value.includes("/workspace") || value.startsWith(".")) {
            options.continueRunDirectory = value;
          } else {
            options.continueBranch = value;
          }
        } else {
          options.continueBranch = value;
        }
        break;
      }
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
  const value = readValue(args, index, flag);
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed.toString() !== value) {
    throw new Error(`Expected ${flag} to be a positive integer.`);
  }

  return parsed;
}

function isHarnessCommand(value: string): value is HarnessCommand {
  return COMMANDS.has(value as HarnessCommand);
}
