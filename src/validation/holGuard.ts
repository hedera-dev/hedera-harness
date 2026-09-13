import { executeCommand, type ExecuteCommandOptions } from "../command.js";
import type {
  CommandExecutionResult,
  HolGuardConfig,
  HolGuardFailOnSeverity,
  HolGuardScanSummary,
  HolGuardSeverity,
  ValidationFinding,
} from "../types.js";

/**
 * HOL Guard's `plugin-scanner` inside ASSERT.
 *
 * The scanner reads the workspace for AI plugin, skill, MCP and agent-workspace
 * risks and prints a `scan-result.v1` JSON report. Findings at or above the
 * recipe's threshold become ordinary ASSERT findings with stable ids, so a rule
 * that keeps firing on the same file is one open finding across attempts, not
 * one fixed and one new.
 *
 * Tooling failures never become findings. A missing `uvx`, a scanner crash or
 * output that is not the report are returned as `infrastructureFailure`; the
 * attempt loop aborts through the same path as an EVALUATE infrastructure
 * failure instead of asking the coding agent to "repair" the scanner.
 */

/** Arguments the harness always appends to `validators.holGuard.command`. */
export const HOL_GUARD_SCAN_ARGS = ["scan", ".", "--format", "json"] as const;

/** Least to most severe, so a numeric compare implements the threshold. */
const SEVERITY_RANK: Record<HolGuardSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** One entry of the report's top-level `findings[]` (hol-guard `scan-result.v1`). */
interface HolGuardReportFinding {
  ruleId?: unknown;
  severity?: unknown;
  category?: unknown;
  title?: unknown;
  description?: unknown;
  remediation?: unknown;
  filePath?: unknown;
  lineNumber?: unknown;
}

interface HolGuardReport {
  schema_version?: unknown;
  score?: unknown;
  grade?: unknown;
  findings?: unknown;
}

export interface HolGuardScanOutcome {
  findings: ValidationFinding[];
  summary?: HolGuardScanSummary;
  /** Set when the scanner could not deliver a report. Never accompanied by findings. */
  infrastructureFailure?: string;
  commandResult?: CommandExecutionResult;
}

export interface HolGuardScanDeps {
  execute?: (options: ExecuteCommandOptions) => Promise<CommandExecutionResult>;
}

/** The exact shell command ASSERT (and `validate`) runs for a config. */
export function holGuardScanCommand(config: HolGuardConfig): string {
  const profile = config.profile ? ` --profile ${config.profile}` : "";
  return `${config.command} ${HOL_GUARD_SCAN_ARGS.join(" ")}${profile}`;
}

/**
 * Run the scanner against the workspace. Resolves in every case: the caller
 * decides between findings and an infrastructure abort, and ASSERT never throws
 * out of the attempt loop.
 */
export async function runHolGuardScan(
  workspacePath: string,
  config: HolGuardConfig,
  deps: HolGuardScanDeps = {},
): Promise<HolGuardScanOutcome> {
  const execute = deps.execute ?? executeCommand;
  const command = holGuardScanCommand(config);
  console.log(`[hedera-harness] HOL Guard scan: ${command}`);

  let result: CommandExecutionResult;
  try {
    result = await execute({
      command,
      cwd: workspacePath,
      timeoutMs: config.timeoutMs,
      shell: true,
    });
  } catch (error) {
    return {
      findings: [],
      infrastructureFailure: `HOL Guard scanner could not be started (${command}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (result.timedOut) {
    return {
      findings: [],
      commandResult: result,
      infrastructureFailure: `HOL Guard scanner timed out after ${Math.round(config.timeoutMs / 1000)}s (${command}).`,
    };
  }

  // The scanner exits non-zero when its own policy or score gate fails, with the
  // report still on stdout. Only a missing report is a tooling failure.
  const parsed = parseHolGuardReport(result.stdout);
  if (!parsed) {
    return {
      findings: [],
      commandResult: result,
      infrastructureFailure: describeMissingReport(command, result),
    };
  }

  const converted = buildHolGuardFindings(parsed, { failOnSeverity: config.failOnSeverity });
  return {
    findings: converted.findings,
    commandResult: result,
    summary: {
      command,
      score: typeof parsed.score === "number" ? parsed.score : undefined,
      grade: typeof parsed.grade === "string" ? parsed.grade : undefined,
      findingsTotal: converted.total,
      blockingTotal: converted.findings.length,
      failOnSeverity: config.failOnSeverity,
      durationMs: result.durationMs,
    },
  };
}

/**
 * The report is the last JSON object on stdout: `uvx` may print install
 * progress before it, and the scanner prints hints after it in some modes.
 */
export function parseHolGuardReport(stdout: string): HolGuardReport | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value) && "findings" in value) {
        const report = value as HolGuardReport;
        if (Array.isArray(report.findings)) return report;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Pure conversion from a parsed report to harness findings, unit-testable
 * against a fixture without the scanner installed.
 */
export function buildHolGuardFindings(
  report: HolGuardReport,
  options: { failOnSeverity: HolGuardFailOnSeverity },
): { findings: ValidationFinding[]; total: number } {
  const threshold = SEVERITY_RANK[options.failOnSeverity];
  const entries = (report.findings as unknown[]).filter(
    (entry): entry is HolGuardReportFinding => Boolean(entry) && typeof entry === "object",
  );

  const byId = new Map<string, ValidationFinding>();
  for (const entry of entries) {
    const severity = readSeverity(entry.severity);
    if (SEVERITY_RANK[severity] < threshold) continue;

    const ruleId = typeof entry.ruleId === "string" && entry.ruleId ? entry.ruleId : "UNKNOWN_RULE";
    const filePath = typeof entry.filePath === "string" && entry.filePath ? entry.filePath : undefined;
    const line = typeof entry.lineNumber === "number" ? entry.lineNumber : undefined;
    const location = filePath ? `${filePath}${line !== undefined ? `:${line}` : ""}` : undefined;

    // Stable across attempts on purpose (see #65): rule + file + line, never
    // the attempt number or the scanner's ordering.
    const id = `hol-guard:${ruleId}${location ? `:${location}` : ""}`;
    if (byId.has(id)) continue;

    const title = typeof entry.title === "string" && entry.title ? entry.title : ruleId;
    const details = [
      typeof entry.description === "string" ? entry.description : "",
      typeof entry.remediation === "string" && entry.remediation
        ? `Remediation: ${entry.remediation}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    byId.set(id, {
      id,
      category: "security",
      message: `[${severity.toUpperCase()}] ${ruleId}: ${title}${location ? ` (${location})` : ""}`,
      details: details ? truncate(details) : undefined,
    });
  }

  const findings = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { findings, total: entries.length };
}

function readSeverity(value: unknown): HolGuardSeverity {
  const lowered = typeof value === "string" ? value.toLowerCase() : "";
  return lowered in SEVERITY_RANK ? (lowered as HolGuardSeverity) : "info";
}

function describeMissingReport(command: string, result: CommandExecutionResult): string {
  const noise = truncate((result.stderr || result.stdout).trim(), 600);
  if (result.exitCode === 127) {
    return `HOL Guard scanner is not installed: \`${command}\` exited 127 (command not found). ${noise}`.trim();
  }
  return `HOL Guard scanner did not produce a JSON report (exit ${result.exitCode ?? "null"} from \`${command}\`). This is a tooling failure, not an app finding. ${noise}`.trim();
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
