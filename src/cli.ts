import { runHarness, validateSemanticWorkspace, validateWorkspace } from "./runner.js";
import type { CliOptions, HarnessCommand, ParsedCli } from "./types.js";

const COMMANDS = new Set<HarnessCommand>(["run", "validate", "validate-semantic"]);

export function parseCliArgs(argv: string[]): ParsedCli {
  const [rawCommand, specPath, ...rest] = argv;

  if (!rawCommand || !isHarnessCommand(rawCommand)) {
    throw new Error(`Expected command "run", "validate", or "validate-semantic".`);
  }

  if (!specPath || specPath.startsWith("-")) {
    throw new Error(`Expected a template spec path.`);
  }

  return {
    command: rawCommand,
    options: parseOptions(specPath, rest),
  };
}

export function printHelp(): void {
  console.log(`hedera-harness

Usage:
  hedera-harness run <spec> [--max-attempts <count>]
  hedera-harness run <spec> --continue <run-dir> [--max-attempts <count>]
  hedera-harness validate <spec> --workspace <path>
  hedera-harness validate-semantic <spec> --workspace <path>

Examples:
  hedera-harness run specs/hedera-demo-from-main.yaml
  hedera-harness run specs/hedera-demo-from-main.yaml --max-attempts 3
  hedera-harness run specs/my-template.yaml --continue runs/<run-id> --max-attempts 3
  hedera-harness validate specs/hedera-demo-from-main.yaml --workspace runs/<run-id>/workspace
  hedera-harness validate-semantic specs/hedera-demo-from-main.yaml --workspace runs/<run-id>/workspace`);
}

export async function runCli(parsed: ParsedCli): Promise<void> {
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

  const report = await runHarness(parsed.options);
  const summaryLines = [
    `Harness run finished`,
    `spec=${report.specName}`,
    `passed=${report.passed}`,
    `oracleAudit=${report.blindIntegrity.passed ? "passed" : "failed"}`,
    `attempts=${report.attempts}/${report.maxAttempts}`,
    report.cycle ? `cycle=${report.cycle} attemptsThisCycle=${report.attemptsThisCycle}` : undefined,
    `findings=${report.validation.findings.length}`,
    `workspace=${report.workspacePath}`,
    `report=${report.runDirectory}/reports/report.json`,
    `validationLog=${report.runDirectory}/logs/validation-attempt-${report.attempts}.json`,
    `oracleAuditLog=${report.runDirectory}/logs/oracle-audit-attempt-${report.attempts}.json`,
    `jsonlLog=runs/harness.log.jsonl`,
    `notesLog=runs/harness-notes.md`,
  ];

  if (report.passed && !report.blindIntegrity.passed) {
    summaryLines.push(
      `WARNING: validation passed but oracle audit detected peeking (${report.blindIntegrity.findings.length} finding(s))`,
    );
  }

  if (!report.passed) {
    summaryLines.push(...report.validation.findings.map(finding => `- ${finding.message}`));
  }

  console.log(summaryLines.join("\n"));

  if (!report.passed) {
    process.exitCode = 1;
  }
}

function parseOptions(specPath: string, args: string[]): CliOptions {
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
      case "--continue":
        options.continueRunDirectory = readValue(args, ++index, arg);
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
