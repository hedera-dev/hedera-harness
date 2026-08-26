import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { appendHarnessLog, writeJsonFile, writeStatusFile, type RunLayout } from "./runArtifacts.js";
import type { AgentProgress } from "./agentStreamLogger.js";
import type {
  AgentRunResult,
  ChainSigner,
  CommandExecutionResult,
  PlaywrightGateResult,
  SemanticValidationResult,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "./types.js";
import { executeCommand } from "./command.js";
import { runDeterministicValidation } from "./validation/index.js";
import { buildDeployEnv } from "./validation/chainSigner.js";
import { isValidatorEnabled, runSemanticValidation } from "./semanticValidator.js";
import {
  createDevServerSession,
  loadDevServerConfig,
  type DevServerSession,
} from "./validation/devServer.js";
import { runPlaywrightGate } from "./validation/playwrightGate.js";
import { withValidatorMcp } from "./validatorMcp.js";
import { WorkspaceWatcher } from "./workspaceWatcher.js";

/**
 * One attempt runs four stages in order:
 *
 *   GENERATE -> ASSERT -> SMOKE -> EVALUATE
 *
 * Each stage may short-circuit the rest of the attempt. That ordering is a cost
 * decision as much as a correctness one: ASSERT is cheap and deterministic, so a
 * failing build never pays for a dev server boot or an adversarial evaluator pass.
 */
export const STAGE_NAMES = ["GENERATE", "ASSERT", "SMOKE", "EVALUATE"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface AttemptStageContext {
  attempt: number;
  spec: TemplateSpec;
  workspacePath: string;
  layout: RunLayout;
  chainSigner?: ChainSigner;
  /** Vendored acceptance-contract path, relative to the workspace. */
  contractRelativePath?: string;
}

export interface GenerateStageResult {
  agentResult: AgentRunResult;
  /** Present when the agent exited non-zero or could not be spawned. */
  finding?: ValidationFinding;
}

export function logStage(stage: StageName, detail?: string): void {
  const index = STAGE_NAMES.indexOf(stage) + 1;
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`[hedera-harness] Stage ${index}/${STAGE_NAMES.length} ${stage}${suffix}`);
}

/**
 * GENERATE — run the coding agent against the current prompt.
 *
 * A non-zero exit becomes a finding rather than an exception so the attempt can
 * still run ASSERT and report deterministic context alongside the agent failure.
 */
export async function runGenerateStage(
  context: AttemptStageContext,
  input: {
    generator: CommandAgentProvider;
    prompt: string;
    agentLogPath: string;
    agentActivityLogPath: string;
    workspaceActivityLogPath: string;
  },
): Promise<GenerateStageResult> {
  const { attempt, spec, workspacePath, layout } = context;
  const startedAtMs = Date.now();

  let latestProgress: AgentProgress = {
    lastActivity: "agent process spawned",
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
  };

  const writeProgress = (progress: AgentProgress): Promise<void> =>
    writeStatusFile(layout.runDirectory, {
      phase: "generator_running",
      stage: "GENERATE",
      attempt,
      elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      lastActivity: progress.lastActivity,
      toolCallsStarted: progress.toolCallsStarted,
      toolCallsCompleted: progress.toolCallsCompleted,
      sessionId: progress.sessionId,
      activityLogPath: input.agentActivityLogPath,
      workspaceActivityLogPath: input.workspaceActivityLogPath,
    });

  const workspaceWatcher = new WorkspaceWatcher(
    workspacePath,
    input.workspaceActivityLogPath,
    async summary => {
      latestProgress = { ...latestProgress, lastActivity: summary };
      await writeProgress(latestProgress);
    },
  );
  await workspaceWatcher.start();

  const heartbeat = setInterval(() => {
    void writeProgress(latestProgress);
    console.log(
      `[hedera-harness] agent still running (${Math.round((Date.now() - startedAtMs) / 1000)}s) — ${latestProgress.lastActivity}`,
    );
  }, 15_000);

  let agentResult: AgentRunResult;
  try {
    agentResult = await input.generator.run({
      workspacePath,
      prompt: input.prompt,
      attempt,
      timeoutMs: spec.generator.timeoutMs,
      logPath: input.agentLogPath,
      activityLogPath: input.agentActivityLogPath,
      onProgress: async progress => {
        latestProgress = progress;
        await writeProgress(progress);
      },
    });
  } catch (error) {
    agentResult = {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: 0,
      command: spec.generator.command,
      args: spec.generator.args ?? [],
      timedOut: false,
      signal: null,
    };
  } finally {
    clearInterval(heartbeat);
    await workspaceWatcher.stop();
  }

  await appendHarnessLog(layout.jsonlLogPath, {
    type: "generator_finished",
    timestamp: new Date().toISOString(),
    attempt,
    exitCode: agentResult.exitCode,
    durationMs: agentResult.durationMs,
    timedOut: agentResult.timedOut,
  });

  if (agentResult.exitCode === 0) {
    return { agentResult };
  }

  return {
    agentResult,
    finding: {
      id: agentResult.timedOut ? `generator-timeout:${attempt}` : `generator-exit:${attempt}`,
      category: "agent",
      message: agentResult.timedOut
        ? `Generator agent timed out after ${Math.round(agentResult.durationMs / 1000)}s`
        : `Generator agent exited with code ${agentResult.exitCode ?? "null"}`,
      details: truncate(agentResult.stderr || agentResult.stdout),
    },
  };
}

/** ASSERT — deterministic gates: required/forbidden files, static config, secrets, commands. */
export async function runAssertStage(
  context: AttemptStageContext,
  options: { skipPlaywrightGate: boolean },
): Promise<ValidationResult> {
  return runDeterministicValidation(context.workspacePath, context.spec, {
    skipPlaywrightGate: options.skipPlaywrightGate,
    installCachePath: path.join(context.layout.cacheDirectory, "install-fingerprint.txt"),
  });
}

/**
 * SMOKE — prove the app actually runs: optional on-chain deploy, then boot the dev
 * server and walk the configured routes.
 */
export async function runSmokeStage(
  context: AttemptStageContext,
  devServer: DevServerSession,
): Promise<{ findings: ValidationFinding[]; playwrightGate?: PlaywrightGateResult }> {
  const playwrightPath = context.spec.validators.playwrightPath!;
  const gate = await runPlaywrightGate(context.workspacePath, playwrightPath, devServer);
  return { findings: gate.findings, playwrightGate: gate.result };
}

/** Optional on-chain deploy hook (Solidity templates), before the app starts. */
export async function runChainDeploy(
  context: AttemptStageContext,
): Promise<ValidationFinding[]> {
  const commands = context.spec.chainValidation?.deploy?.commands ?? [];
  if (!context.chainSigner || commands.length === 0) return [];

  const env = buildDeployEnv(
    context.chainSigner,
    context.spec.chainValidation?.expose.envVars ?? [],
  );
  const findings: ValidationFinding[] = [];

  for (const commandConfig of commands) {
    console.log(`[hedera-harness] Chain deploy: ${commandConfig.name} — ${commandConfig.command}`);
    const result = await executeCommand({
      command: commandConfig.command,
      cwd: context.workspacePath,
      env,
      timeoutMs: commandConfig.timeoutMs,
      shell: true,
    });
    if (result.exitCode !== 0) {
      findings.push({
        id: `chain-deploy:${commandConfig.name}`,
        category: "commands",
        message: `Chain deploy command failed: ${commandConfig.name}`,
        details: truncate(result.stderr || result.stdout),
      });
    }
  }

  return findings;
}

/** EVALUATE — adversarial validator grades the live app against the acceptance contract. */
export async function runEvaluateStage(
  context: AttemptStageContext,
  devServer: DevServerSession,
  extraValidatorArgs: string[] = [],
): Promise<SemanticValidationResult> {
  const { attempt, layout } = context;
  const validatorPromptPath = path.join(
    layout.promptsDirectory,
    `validator-attempt-${attempt}.txt`,
  );

  await appendHarnessLog(layout.jsonlLogPath, {
    type: "validator_started",
    timestamp: new Date().toISOString(),
    attempt,
    promptPath: validatorPromptPath,
    serverUrl: devServer.url,
  });
  logStage("EVALUATE", devServer.url);

  const semanticValidation = await runSemanticValidation({
    workspacePath: context.workspacePath,
    spec: context.spec,
    attempt,
    logsDirectory: layout.logsDirectory,
    promptsDirectory: layout.promptsDirectory,
    devServer,
    chainSigner: context.chainSigner,
    contractRelativePath: context.contractRelativePath,
    extraArgs: extraValidatorArgs,
  });

  await writeJsonFile(
    path.join(layout.logsDirectory, `semantic-validation-attempt-${attempt}.json`),
    semanticValidation,
  );
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "validator_finished",
    timestamp: new Date().toISOString(),
    attempt,
    passed: semanticValidation.passed,
    findingCount: semanticValidation.findings.length,
    durationMs: semanticValidation.durationMs,
    infrastructureFailure: semanticValidation.infrastructureFailure,
    infrastructureFailureReason: semanticValidation.infrastructureFailureReason,
  });

  return semanticValidation;
}

/**
 * Run ASSERT, then SMOKE and EVALUATE if the cheap gates left nothing open.
 *
 * SMOKE and EVALUATE share one dev server for the attempt: booting a Next app
 * twice per attempt is the single most expensive thing the harness could do.
 */
export async function runValidationStages(
  context: AttemptStageContext,
  generateFinding?: ValidationFinding,
): Promise<ValidationResult> {
  const usesSharedDevServer =
    isValidatorEnabled(context.spec) && Boolean(context.spec.validators.playwrightPath);

  logStage("ASSERT");
  const deterministic = await runAssertStage(context, {
    skipPlaywrightGate: usesSharedDevServer,
  });

  const validation: ValidationResult = generateFinding
    ? {
        passed: false,
        findings: [generateFinding, ...deterministic.findings],
        commandResults: deterministic.commandResults,
        playwrightGate: deterministic.playwrightGate,
      }
    : deterministic;

  const deterministicClean =
    validation.findings.filter(finding => finding.category !== "agent").length === 0;

  if (generateFinding || !deterministicClean) {
    logStage("SMOKE", "skipped — deterministic gates are not clean");
    return validation;
  }
  if (!usesSharedDevServer) {
    return validation;
  }

  let mcpArgs: string[] = [];

  const runtimeStages = async (): Promise<ValidationResult> => {
    const deployFindings = await runChainDeploy(context);
    if (deployFindings.length > 0) {
      logStage("SMOKE", "chain deploy failed");
      return {
        ...validation,
        passed: false,
        findings: [...validation.findings, ...deployFindings],
      };
    }

    const serverConfig = await loadDevServerConfig(context.spec.validators.playwrightPath!);
    let devServer: DevServerSession | null = null;
    try {
      logStage("SMOKE", "booting dev server");
      devServer = await createDevServerSession(context.workspacePath, serverConfig, "runtime");

      const smoke = await runSmokeStage(context, devServer);
      const afterSmoke: ValidationResult = {
        ...validation,
        findings: [...validation.findings, ...smoke.findings],
        playwrightGate: smoke.playwrightGate,
      };
      afterSmoke.passed =
        afterSmoke.findings.filter(finding => finding.category !== "agent").length === 0;

      if (!afterSmoke.passed) {
        logStage("EVALUATE", "skipped — smoke gate failed");
        return afterSmoke;
      }

      const semanticValidation = await runEvaluateStage(context, devServer, mcpArgs);
      return semanticValidation.passed
        ? { ...afterSmoke, semanticValidation }
        : {
            ...afterSmoke,
            passed: false,
            findings: [...afterSmoke.findings, ...semanticValidation.findings],
            semanticValidation,
          };
    } finally {
      await devServer?.stop();
    }
  };

  return withValidatorMcp(
    {
      agent: context.spec.agent,
      workspacePath: context.workspacePath,
      artifactsDirectory: context.layout.runDirectory,
    },
    async extraArgs => {
      mcpArgs = extraArgs;
      return runtimeStages();
    },
  );
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

export type { CommandExecutionResult };
