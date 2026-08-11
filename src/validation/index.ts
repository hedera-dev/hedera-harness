import { readFile } from "node:fs/promises";
import path from "node:path";
import { executeCommand } from "../command.js";
import { pathExists } from "../fsUtils.js";
import type {
  CommandExecutionResult,
  PlaywrightGateResult,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "../types.js";
import { runPlaywrightGate } from "./playwrightGate.js";
import {
  computeInstallFingerprint,
  readCachedInstallFingerprint,
  writeCachedInstallFingerprint,
} from "./installFingerprint.js";

export interface DeterministicValidationOptions {
  /** When true, Playwright gate is omitted (caller runs it with a shared dev server). */
  skipPlaywrightGate?: boolean;
  /** Persist install fingerprint across attempts under this run cache path. */
  installCachePath?: string;
}

interface StaticValidatorConfig {
  jsonAssertions?: Array<{
    file: string;
    path: string;
    equals: unknown;
  }>;
  fileAssertions?: {
    required?: string[];
    forbidden?: string[];
  };
  textAssertions?: Array<{
    file: string;
    contains: string[];
  }>;
  secretScan?: {
    failOnFiles?: string[];
    patterns?: Array<{
      name: string;
      pattern: string;
      allowIn?: string[];
    }>;
  };
}

interface CommandValidatorConfig {
  commands: Array<{
    name: string;
    command: string;
    timeoutMs?: number;
  }>;
}

/**
 * Directories the secret scan never walks.
 *
 * Harness runtime is excluded deliberately: `.harness/runs/<id>/` holds the
 * ephemeral signer and run artifacts, so scanning it reports the harness's own
 * material as a finding against the app under test.
 */
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "artifacts",
  "cache",
  ".harness",
  ".harness-context",
  ".harness-skills",
  ".harness-semantic",
  ".skill-cache",
]);

export async function runDeterministicValidation(
  workspacePath: string,
  spec: TemplateSpec,
  options: DeterministicValidationOptions = {},
): Promise<ValidationResult> {
  const findings: ValidationFinding[] = [];
  const commandResults: CommandExecutionResult[] = [];

  findings.push(...(await validateRequiredFiles(workspacePath, spec.requiredFiles)));
  findings.push(...(await validateForbiddenFiles(workspacePath, spec.forbiddenFiles)));
  findings.push(...(await validateStaticConfig(workspacePath, spec.validators.staticPath)));
  findings.push(...(await validateSecretScan(workspacePath, spec)));

  const commandValidation = await validateCommands(
    workspacePath,
    spec.validators.commandsPath,
    options.installCachePath,
  );
  findings.push(...commandValidation.findings);
  commandResults.push(...commandValidation.commandResults);

  let playwrightGate: PlaywrightGateResult | undefined;
  if (spec.validators.playwrightPath && !options.skipPlaywrightGate) {
    if (commandValidation.findings.length === 0) {
      console.log("[hedera-harness] Running thin Playwright gate...");
      const gate = await runPlaywrightGate(workspacePath, spec.validators.playwrightPath);
      playwrightGate = gate.result;
      findings.push(...gate.findings);
    } else {
      console.log(
        "[hedera-harness] Skipping Playwright gate because yarn command validation failed.",
      );
    }
  }

  return {
    passed: findings.length === 0,
    findings,
    commandResults,
    playwrightGate,
  };
}

async function validateRequiredFiles(workspacePath: string, requiredFiles: string[]): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];

  for (const relativePath of requiredFiles) {
    if (!(await pathExists(path.join(workspacePath, relativePath)))) {
      findings.push({
        id: `required-file:${relativePath}`,
        category: "files",
        message: `Required file is missing: ${relativePath}`,
      });
    }
  }

  return findings;
}

async function validateForbiddenFiles(
  workspacePath: string,
  forbiddenFiles: string[],
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];

  for (const relativePath of forbiddenFiles) {
    if (await pathExists(path.join(workspacePath, relativePath))) {
      findings.push({
        id: `forbidden-file:${relativePath}`,
        category: "files",
        message: `Forbidden file or directory exists: ${relativePath}`,
      });
    }
  }

  return findings;
}

async function validateStaticConfig(workspacePath: string, staticPath: string): Promise<ValidationFinding[]> {
  const raw = await readFile(staticPath, "utf8");
  const config = JSON.parse(raw) as StaticValidatorConfig;
  const findings: ValidationFinding[] = [];

  for (const assertion of config.jsonAssertions ?? []) {
    const filePath = path.join(workspacePath, assertion.file);
    if (!(await pathExists(filePath))) continue;

    // A generated file with broken JSON is an app defect, not a harness crash.
    let content: unknown;
    try {
      content = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      findings.push({
        id: `json-parse:${assertion.file}`,
        category: "static",
        message: `Could not parse ${assertion.file} as JSON`,
        details: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const actual = getByPath(content, assertion.path);
    if (!valuesEqual(actual, assertion.equals)) {
      findings.push({
        id: `json:${assertion.file}:${assertion.path}`,
        category: "static",
        message: `JSON assertion failed in ${assertion.file} at ${assertion.path}`,
        details: `Expected ${JSON.stringify(assertion.equals)} but found ${JSON.stringify(actual)}`,
      });
    }
  }

  for (const relativePath of config.fileAssertions?.required ?? []) {
    if (!(await pathExists(path.join(workspacePath, relativePath)))) {
      findings.push({
        id: `static-required:${relativePath}`,
        category: "static",
        message: `Static validator requires file: ${relativePath}`,
      });
    }
  }

  for (const relativePath of config.fileAssertions?.forbidden ?? []) {
    if (await pathExists(path.join(workspacePath, relativePath))) {
      findings.push({
        id: `static-forbidden:${relativePath}`,
        category: "static",
        message: `Static validator forbids path: ${relativePath}`,
      });
    }
  }

  for (const assertion of config.textAssertions ?? []) {
    const filePath = path.join(workspacePath, assertion.file);
    if (!(await pathExists(filePath))) {
      findings.push({
        id: `text-missing:${assertion.file}`,
        category: "static",
        message: `Text assertion file missing: ${assertion.file}`,
      });
      continue;
    }

    const content = await readFile(filePath, "utf8");
    for (const needle of assertion.contains) {
      if (!content.includes(needle)) {
        findings.push({
          id: `text:${assertion.file}:${needle}`,
          category: "static",
          message: `Expected ${assertion.file} to contain "${needle}"`,
        });
      }
    }
  }

  if (config.secretScan) {
    findings.push(...(await scanSecrets(workspacePath, config.secretScan)));
  }

  return findings;
}

async function validateSecretScan(workspacePath: string, spec: TemplateSpec): Promise<ValidationFinding[]> {
  if (!spec.secretScan) return [];
  return scanSecrets(workspacePath, spec.secretScan);
}

async function scanSecrets(
  workspacePath: string,
  secretScan: {
    failOnFiles?: string[];
    patterns?: Array<{ name: string; pattern: string; allowIn?: string[] }>;
  },
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];

  for (const relativePath of secretScan.failOnFiles ?? []) {
    if (await pathExists(path.join(workspacePath, relativePath))) {
      findings.push({
        id: `secret-file:${relativePath}`,
        category: "secret",
        message: `Secret scan forbids file: ${relativePath}`,
      });
    }
  }

  const filesToScan = await collectTextFiles(workspacePath);
  for (const relativePath of filesToScan) {
    const content = await readFile(path.join(workspacePath, relativePath), "utf8");
    for (const pattern of secretScan.patterns ?? []) {
      if (pattern.allowIn?.includes(relativePath)) continue;
      const regex = new RegExp(pattern.pattern, "m");
      if (regex.test(content)) {
        findings.push({
          id: `secret-pattern:${pattern.name}:${relativePath}`,
          category: "secret",
          message: `Secret pattern "${pattern.name}" matched in ${relativePath}`,
        });
      }
    }
  }

  return findings;
}

async function validateCommands(
  workspacePath: string,
  commandsPath: string,
  installCachePath?: string,
) {
  const raw = await readFile(commandsPath, "utf8");
  const config = JSON.parse(raw) as CommandValidatorConfig;
  const findings: ValidationFinding[] = [];
  const commandResults: CommandExecutionResult[] = [];

  for (const commandConfig of config.commands) {
    if (commandConfig.name === "install" && installCachePath) {
      const currentFingerprint = await computeInstallFingerprint(workspacePath);
      const cachedFingerprint = await readCachedInstallFingerprint(installCachePath);
      if (cachedFingerprint && cachedFingerprint === currentFingerprint) {
        console.log("[hedera-harness] Skipping yarn install (dependency fingerprint unchanged).");
        commandResults.push({
          command: commandConfig.command,
          args: [],
          exitCode: 0,
          stdout: "skipped: dependency fingerprint unchanged",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          signal: null,
          skipped: true,
          skipReason: "fingerprint-unchanged",
        });
        continue;
      }
    }

    const result = await executeCommand({
      command: commandConfig.command,
      cwd: workspacePath,
      timeoutMs: commandConfig.timeoutMs,
      shell: true,
    });
    commandResults.push(result);

    if (result.exitCode !== 0) {
      findings.push({
        id: `command:${commandConfig.name}`,
        category: "commands",
        message: `Validation command failed: ${commandConfig.name}`,
        details: truncateOutput(result.stderr || result.stdout),
      });
      continue;
    }

    if (commandConfig.name === "install" && installCachePath) {
      const fingerprint = await computeInstallFingerprint(workspacePath);
      await writeCachedInstallFingerprint(installCachePath, fingerprint);
    }
  }

  return { findings, commandResults };
}

async function collectTextFiles(workspacePath: string, current = ""): Promise<string[]> {
  const absoluteCurrent = path.join(workspacePath, current);
  let entries: string[] = [];

  try {
    const { readdir } = await import("node:fs/promises");
    const dirEntries = await readdir(absoluteCurrent, { withFileTypes: true });

    for (const entry of dirEntries) {
      const relativePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) {
          continue;
        }
        entries = entries.concat(await collectTextFiles(workspacePath, relativePath));
        continue;
      }

      if (/\.(ts|tsx|js|jsx|json|md|yaml|yml|env\.example)$/i.test(entry.name)) {
        entries.push(relativePath);
      }
    }
  } catch {
    return entries;
  }

  return entries;
}

function getByPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return true;
  }

  // Accept a scalar when the spec expects a single-item array (common generator drift).
  if (Array.isArray(expected) && expected.length === 1) {
    const expectedItem = expected[0];
    if (JSON.stringify(actual) === JSON.stringify(expectedItem)) {
      return true;
    }
    if (Array.isArray(actual) && actual.length === 1 && JSON.stringify(actual[0]) === JSON.stringify(expectedItem)) {
      return true;
    }
  }

  return false;
}

function truncateOutput(output: string, maxLength = 1200): string {
  const trimmed = output.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
