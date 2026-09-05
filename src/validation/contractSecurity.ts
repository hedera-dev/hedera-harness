import path from "node:path";
import { readdir } from "node:fs/promises";
import { executeCommand } from "../command.js";
import { pathExists } from "../fsUtils.js";
import type {
  BlockingSeverity,
  ContractSecurityConfig,
  SecuritySeverity,
  ValidationFinding,
} from "../types.js";

/**
 * A scanner could not run to a verdict — binary missing, no contracts to scan,
 * unparseable output. This is a harness/infrastructure problem, not an app
 * defect: the coding agent cannot "repair" a contract into existence or install
 * Slither. ASSERT surfaces it as an abort (the way chainSigner surfaces
 * provisioning failures), and `doctor` pre-empts it before a long run.
 */
export class ContractSecurityInfraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractSecurityInfraError";
  }
}

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/** Ordered least→most severe, so a numeric compare implements the threshold. */
const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Slither reports `impact` as High/Medium/Low/Informational and has no
 * "Critical" tier; the harness keeps `critical` in the type for other scanners
 * and future use, but Slither's High is the top blocking level today.
 */
function mapSlitherImpact(impact: string): SecuritySeverity {
  switch (impact.toLowerCase()) {
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "low":
      return "low";
    default:
      return "informational";
  }
}

/** Candidate contract roots, in priority order, when `contractsDir` is unset. */
const CONTRACT_DIR_CANDIDATES = [
  ".",
  "packages/foundry",
  "packages/hardhat",
  "contracts",
];

const SOL_SKIP_DIRS = new Set(["node_modules", "lib", ".git", "out", "artifacts", "cache"]);

/**
 * Entry point called from the ASSERT stage. A no-op unless the validator is
 * explicitly enabled, so default recipes are unaffected.
 */
export async function validateContractSecurity(
  workspacePath: string,
  config: ContractSecurityConfig | undefined,
): Promise<{ findings: ValidationFinding[] }> {
  if (!config?.enabled) return { findings: [] };

  const contractsDir = await resolveContractsDir(workspacePath, config.contractsDir);
  const findings: ValidationFinding[] = [];

  for (const scanner of config.scanners) {
    if (scanner === "slither") {
      findings.push(...(await runSlither(workspacePath, contractsDir, config)));
    }
  }

  // Deterministic order so run notes and the lifecycle delta read stably.
  findings.sort((a, b) => a.id.localeCompare(b.id));
  return { findings };
}

async function runSlither(
  workspacePath: string,
  contractsDir: string,
  config: ContractSecurityConfig,
): Promise<ValidationFinding[]> {
  const relDir = path.relative(workspacePath, contractsDir) || ".";
  console.log(`[hedera-harness] Contract security: slither ${relDir}`);

  const result = await executeCommand({
    // `--json -` streams the machine-readable report to stdout; logs go to stderr.
    command: `slither ${JSON.stringify(relDir)} --json -`,
    cwd: workspacePath,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    shell: true,
  });

  if (result.timedOut) {
    throw new ContractSecurityInfraError(
      `slither timed out after ${Math.round((config.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s in ${relDir}.`,
    );
  }

  // Slither exits non-zero on genuine findings too, so a bad exit alone is not
  // infra. Unparseable stdout (missing solc, un-compilable project, crash) is —
  // buildSlitherFindings throws ContractSecurityInfraError with stderr context.
  return buildSlitherFindings(result.stdout, {
    workspacePath,
    failOnSeverity: config.failOnSeverity,
    stderr: result.stderr,
  });
}

export interface BuildSlitherFindingsOptions {
  workspacePath: string;
  failOnSeverity: BlockingSeverity;
  /** Passed through for a better infra-error message; optional. */
  stderr?: string;
}

/**
 * Pure conversion from Slither's `--json -` stdout to harness findings. Kept
 * separate from process spawning so it can be unit-tested against captured
 * fixtures without a real Slither install. Throws ContractSecurityInfraError
 * when the output is not a usable report.
 */
export function buildSlitherFindings(
  stdout: string,
  options: BuildSlitherFindingsOptions,
): ValidationFinding[] {
  const report = parseSlitherJson(stdout);
  if (!report) {
    throw new ContractSecurityInfraError(
      [
        "slither did not produce parseable JSON.",
        "This is a tooling/compile failure, not a contract vulnerability.",
        truncate(options.stderr || stdout, 800),
      ].join(" "),
    );
  }

  if (report.success === false && (!report.results || !report.results.detectors)) {
    throw new ContractSecurityInfraError(
      `slither reported failure: ${truncate(report.error ?? "unknown error", 800)}`,
    );
  }

  const threshold = SEVERITY_RANK[options.failOnSeverity];
  const findings: ValidationFinding[] = [];

  for (const detector of report.results?.detectors ?? []) {
    const severity = mapSlitherImpact(detector.impact ?? "informational");
    if (SEVERITY_RANK[severity] < threshold) continue;

    const location = firstLocation(detector, options.workspacePath);
    findings.push({
      id: `security:slither:${detector.check}:${location.relPath}:${location.line}`,
      category: "security",
      message: `[${severity.toUpperCase()}] ${detector.check} in ${location.relPath}:${location.line}`,
      details: truncate(detector.description ?? "", 1200),
      status: "open",
    });
  }

  return findings;
}

interface SlitherElement {
  source_mapping?: {
    filename_relative?: string;
    filename_short?: string;
    lines?: number[];
  };
}

interface SlitherDetector {
  check: string;
  impact?: string;
  confidence?: string;
  description?: string;
  elements?: SlitherElement[];
}

interface SlitherReport {
  success?: boolean;
  error?: string | null;
  results?: { detectors?: SlitherDetector[] };
}

/**
 * Slither may print progress lines before the JSON object. Parse the first
 * balanced `{...}` span rather than assuming stdout is pure JSON.
 */
function parseSlitherJson(stdout: string): SlitherReport | undefined {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as SlitherReport;
  } catch {
    return undefined;
  }
}

/**
 * Stable location for the finding id. Uses Slither's relative filename and the
 * first source line; both are deterministic for an unchanged contract, so an
 * unfixed issue keeps its id across attempts and the repair loop reads it as
 * still-open rather than newly introduced.
 */
function firstLocation(
  detector: SlitherDetector,
  workspacePath: string,
): { relPath: string; line: number } {
  for (const element of detector.elements ?? []) {
    const mapping = element.source_mapping;
    const file = mapping?.filename_relative ?? mapping?.filename_short;
    if (file) {
      const relPath = path.isAbsolute(file) ? path.relative(workspacePath, file) : file;
      const line = mapping?.lines?.[0] ?? 0;
      return { relPath, line };
    }
  }
  return { relPath: "<unknown>", line: 0 };
}

async function resolveContractsDir(
  workspacePath: string,
  configured: string | undefined,
): Promise<string> {
  if (configured) {
    if (!(await pathExists(configured))) {
      throw new ContractSecurityInfraError(
        `validators.contractSecurity.contractsDir does not exist: ${configured}`,
      );
    }
    return configured;
  }

  for (const candidate of CONTRACT_DIR_CANDIDATES) {
    const absolute = path.resolve(workspacePath, candidate);
    if (!(await pathExists(absolute))) continue;
    if (await hasSolidity(absolute)) return absolute;
  }

  throw new ContractSecurityInfraError(
    [
      "contractSecurity is enabled but no Solidity project was found.",
      `Looked in: ${CONTRACT_DIR_CANDIDATES.join(", ")}.`,
      "Set validators.contractSecurity.contractsDir in the recipe.",
    ].join(" "),
  );
}

/** Shallow check: a `.sol` file, a foundry.toml, or a hardhat config under `dir`. */
async function hasSolidity(dir: string, depth = 2): Promise<boolean> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile()) {
      if (
        entry.name.endsWith(".sol") ||
        entry.name === "foundry.toml" ||
        /^hardhat\.config\.(t|j)s$/.test(entry.name)
      ) {
        return true;
      }
    }
  }

  if (depth <= 0) return false;
  for (const entry of entries) {
    if (entry.isDirectory() && !SOL_SKIP_DIRS.has(entry.name)) {
      if (await hasSolidity(path.join(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
