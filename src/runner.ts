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
import type { ChainSigner, CliOptions, SemanticValidationResult, ValidationResult } from "./types.js";
import { vendorHarnessContext } from "./contextVendor.js";
import { runDeterministicValidation } from "./validation/index.js";
import {
  createDevServerSession,
  loadDevServerConfig,
} from "./validation/devServer.js";
import { runPlaywrightGate } from "./validation/playwrightGate.js";
import {
  assertChainValidationOperatorEnv,
  provisionChainSigner,
} from "./validation/chainSigner.js";
import { isValidatorEnabled, runSemanticValidation } from "./semanticValidator.js";
import { withValidatorMcp } from "./validatorMcp.js";

export async function validateWorkspace(options: CliOptions): Promise<ValidationResult> {
  // Project-centric default: validate the current project (cwd), like `run`.
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  // Project-centric recipes omit `seed`; validate only needs deterministic gates
  // plus an optional Playwright SMOKE owned by createDevServerSession.
  const loaded = await loadTemplateSpec(options.specPath);
  const { spec } = loaded;
  const deterministic = await runDeterministicValidation(workspacePath, spec);

  const playwrightPath = spec.validators.playwrightPath;
  if (!playwrightPath) {
    return deterministic;
  }

  const commandFailed = deterministic.findings.some(finding => finding.category === "commands");
  if (commandFailed) {
    console.log(
      "[hedera-harness] Skipping Playwright gate because yarn command validation failed.",
    );
    return deterministic;
  }

  const serverConfig = await loadDevServerConfig(playwrightPath);
  let devServer = null as Awaited<ReturnType<typeof createDevServerSession>> | null;
  try {
    console.log("[hedera-harness] Running thin Playwright gate...");
    devServer = await createDevServerSession(workspacePath, serverConfig, "validate");
    const gate = await runPlaywrightGate(workspacePath, playwrightPath, devServer);
    const findings = [...deterministic.findings, ...gate.findings];
    return {
      passed: findings.length === 0,
      findings,
      commandResults: deterministic.commandResults,
      playwrightGate: gate.result,
    };
  } finally {
    await devServer?.stop();
  }
}

/**
 * Run Tier 3 semantic validation alone against an existing workspace
 * (skips generator + deterministic gates). Re-vendors PRD/contract so older
 * runs pick up current harness context.
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

  if (!spec.validators.playwrightPath) {
    throw new Error(
      "Semantic validation requires validators.playwright so the harness can start the dev server.",
    );
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
    vendored.contractRelativePath ?? vendored.prdRelativePath,
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

  const serverConfig = await loadDevServerConfig(spec.validators.playwrightPath);
  let devServer = null as Awaited<ReturnType<typeof createDevServerSession>> | null;
  try {
    devServer = await createDevServerSession(workspacePath, serverConfig, "validate-semantic");
    const result = await withValidatorMcp(
      {
        agent: spec.agent,
        workspacePath,
        artifactsDirectory:
          artifactDirs.runDirectory ?? path.join(workspacePath, ".harness-semantic"),
      },
      extraArgs =>
        runSemanticValidation({
          workspacePath,
          spec,
          attempt,
          logsDirectory: artifactDirs.logsDirectory,
          promptsDirectory: artifactDirs.promptsDirectory,
          chainSigner,
          extraArgs,
          devServer: devServer!,
        }),
    );

    const resultPath = path.join(
      artifactDirs.logsDirectory,
      `semantic-validation-attempt-${attempt}.json`,
    );
    await writeJsonFile(resultPath, result);

    logPhase(
      `Semantic validation ${result.passed ? "passed" : "failed"}`,
      `${result.findings.length} finding(s), ${Math.round(result.durationMs / 1000)}s — ${resultPath}`,
    );

    return result;
  } finally {
    await devServer?.stop();
  }
}
