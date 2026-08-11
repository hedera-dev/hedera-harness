import { runInit } from "./initRunner.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { runHarness, validateSemanticWorkspace, validateWorkspace } from "./runner.js";
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
  hedera-harness init [target-dir] [--repo <url>] [--ref <branch>] [--template <branch>] [--skip-install]
  hedera-harness run [spec] [--max-attempts <count>] [--new] [--continue <branch>]
  hedera-harness doctor [spec] [--workspace <path>]
  hedera-harness validate [spec] [--workspace <path>]
  hedera-harness validate-semantic [spec] [--workspace <path>]

Examples:
  hedera-harness init my-app
  hedera-harness init my-app --ref main
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
  - On a matching harness/run-* (or legacy harness/extend-*) branch + same spec, continues automatically.
  - On a normal branch, or when the spec differs, creates harness/run-<slug>-<id>.
  - --new forces a fresh harness branch; --continue <branch> checks out that branch and resumes.
  - Does not auto-stash, push, open a PR, merge, or delete branches.`);
}

export async function runCli(parsed: ParsedCli): Promise<void> {
  if (parsed.command === "init") {
    const result = await runInit(parsed.initOptions ?? {});
    console.log(
      [
        "Harness project initialized",
        `target=${result.targetDir}`,
        `seed=${result.repo}@${result.ref}`,
        `git=${result.commitSha.slice(0, 8)} (fresh repo on main, no remote)`,
        `recipe=${result.harnessDir}/  (prd.md, spec.yaml, validators/)`,
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

  if (parsed.command === "doctor") {
    const report = await runDoctor(parsed.options);
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
