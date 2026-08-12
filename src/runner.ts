import path from "node:path";
import { access } from "node:fs/promises";
import {
  lastAttemptNumber,
  resolveArtifactDirsForWorkspace,
  resolveRunDirectoryForWorkspace,
  writeJsonFile,
} from "./runArtifacts.js";
import { logPhase } from "./attemptLoop.js";
import { loadTemplateSpec } from "./specLoader.js";
import type { ChainSigner, CliOptions, SemanticValidationResult } from "./types.js";
import { vendorHarnessContext } from "./contextVendor.js";
import { runDeterministicValidation } from "./validation/index.js";
import {
  assertChainValidationOperatorEnv,
  provisionChainSigner,
} from "./validation/chainSigner.js";
import { isValidatorEnabled, runSemanticValidation } from "./semanticValidator.js";
import {
  runSession,
  type SessionRunResult,
  type RunSessionOptions,
} from "./sessionRunner.js";

export interface ProjectRunResult extends SessionRunResult {}

/**
 * Project-centric harness entrypoint.
 *
 * Operates on the project cwd (or `--workspace`), creates/continues
 * `harness/run-*` branches, and stores artifacts under `.harness/runs/`.
 *
 * Bootstrap a project first with `hedera-harness init`.
 */
export async function runHarness(options: RunSessionOptions): Promise<ProjectRunResult> {
  return runSession(options);
}

export async function validateWorkspace(options: CliOptions) {
  // Project-centric default: validate the current project (cwd), like `run`.
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  // Project-centric recipes omit `seed`; validate only needs deterministic gates.
  const loaded = await loadTemplateSpec(options.specPath);
  return runDeterministicValidation(workspacePath, loaded.spec);
}

/**
 * Run Tier 3 semantic validation alone against an existing workspace
 * (skips generator + deterministic gates). Re-vendors PRD/contract/Playwright MCP
 * so older runs pick up current harness tooling.
 */
export async function validateSemanticWorkspace(options: CliOptions): Promise<SemanticValidationResult> {
  // Project-centric default: validate the current project (cwd), like `run`.
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  const loaded = await loadTemplateSpec(options.specPath);
  const { spec } = loaded;

  if (!isValidatorEnabled(spec)) {
    throw new Error(
      "Semantic validator is not enabled in the spec (set validator.enabled: true or configure validator).",
    );
  }

  if (!spec.contractPath) {
    throw new Error("Semantic validation requires spec.contract to be configured.");
  }

  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  const vendored = await vendorHarnessContext(workspacePath, {
    prdPath: spec.prdPaths[0],
    contractPath: spec.contractPath,
  });
  logPhase(
    "Harness context refreshed for semantic validation",
    `.harness-context + ${vendored.playwrightMcpPath ?? "no playwright MCP"}`,
  );

  const artifactDirs = await resolveArtifactDirsForWorkspace(workspacePath);
  const attempt = (await lastAttemptNumber(artifactDirs.logsDirectory)) + 1;

  let chainSigner: ChainSigner | undefined;
  if (spec.chainValidation?.enabled) {
    const runDirectory = await resolveRunDirectoryForWorkspace(workspacePath);
    const provisioned = await provisionChainSigner(spec.chainValidation, runDirectory, {
      projectRoot: process.cwd(),
      packageManager: spec.constraints?.packageManager,
    });
    chainSigner = provisioned.signer;
    logPhase(
      provisioned.reused
        ? provisioned.toppedUpHbar !== undefined
          ? "Chain signer reused + topped up"
          : "Chain signer reused"
        : "Chain signer provisioned",
      provisioned.toppedUpHbar !== undefined
        ? `${chainSigner.accountId} (+${provisioned.toppedUpHbar} HBAR → ${spec.chainValidation.fundingHbar})`
        : `${chainSigner.accountId} (${chainSigner.evmAddress})`,
    );
  }

  logPhase(`Semantic validation attempt ${attempt} started`, workspacePath);

  const result = await runSemanticValidation({
    workspacePath,
    spec,
    attempt,
    logsDirectory: artifactDirs.logsDirectory,
    promptsDirectory: artifactDirs.promptsDirectory,
    chainSigner,
  });

  const resultPath = path.join(artifactDirs.logsDirectory, `semantic-validation-attempt-${attempt}.json`);
  await writeJsonFile(resultPath, result);

  logPhase(
    `Semantic validation ${result.passed ? "passed" : "failed"}`,
    `${result.findings.length} finding(s), ${Math.round(result.durationMs / 1000)}s — ${resultPath}`,
  );

  return result;
}
