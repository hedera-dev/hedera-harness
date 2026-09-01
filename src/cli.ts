import { runInit } from "./initRunner.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { validateSemanticWorkspace, validateWorkspace } from "./runner.js";
import { runSession } from "./sessionRunner.js";
import type { CliOptions, HarnessCommand, InitCliOptions, ParsedCli } from "./types.js";

const COMMANDS = new Set<HarnessCommand>(["init", "run", "doctor", "validate", "validate-semantic"]);
const DEFAULT_RUN_SPEC = ".harness/spec.yaml";

export function parseCliArgs(argv: string[]): ParsedCli {
  const [rawCommand, ...rest] = argv;

  if (!rawCommand || !isHarnessCommand(rawCommand)) {
    throw new Error(
      `Expected command "init", "run", "doctor", "validate", or "validate-semantic".`,
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
  hedera-harness init [target-dir] [--repo <url>] [--ref <branch>] [--template <name>] [--skip-install]
  hedera-harness run [spec] [--max-attempts <count>] [--new] [--continue <branch>]
  hedera-harness doctor [spec] [--workspace <path>] [--recipe-only]
  hedera-harness validate [spec] [--workspace <path>]
  hedera-harness validate-semantic [spec] [--workspace <path>]

Examples:
  hedera-harness init my-app
  hedera-harness init my-app --template hedera-demo
  hedera-harness init                    # adopt the harness in the current project
  hedera-harness run
  hedera-harness run .harness/spec.yaml --max-attempts 3
  hedera-harness run .harness/spec.yaml --new
  hedera-harness run .harness/spec.yaml --continue harness/run-my-feature-abc123
  hedera-harness doctor
  hedera-harness validate
  hedera-harness validate .harness/spec.yaml
  hedera-harness validate-semantic .harness/spec.yaml

Project-centric run notes:
  - Workspace is the current directory (cwd). Bootstrap with \`init\` first (or use an existing app with .harness/).
  - On a matching harness/run-* branch + same spec, continues automatically.
  - On a normal branch, or when the spec differs, creates harness/run-<slug>-<id>.
  - --new forces a fresh harness branch; --continue <branch> checks out that branch and resumes.
  - Does not auto-stash, push, open a PR, merge, or delete branches.`);
}

export async function runCli(parsed: ParsedCli): Promise<void> {
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
        "",
        "Next steps:",
        ...result.nextSteps.map(step => `  ${step}`),
        "",
        "Tip: authoring skills (create/review harness-spec) ship via the hedera-skills",
        "marketplace plugin — they are not copied into the project. Generator skills are",
        "discovered per run from hedera-skills product plugins.",
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
        `EVALUATE finished`,
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

  const { report, outroLines } = await runSession(parsed.options);
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
      case "--recipe-only":
        if (command !== "doctor") {
          throw new Error(`${arg} is only valid for doctor.`);
        }
        options.recipeOnly = true;
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
