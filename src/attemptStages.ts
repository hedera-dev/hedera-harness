import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { appendHarnessLog, writeJsonFile, writeStatusFile, type RunLayout } from "./runArtifacts.js";
import type { AgentProgress } from "./agentStreamLogger.js";
import type {
  AgentRunResult,
  ChainSigner,
  CommandExecutionResult,
  EvaluationResult,
  PlaywrightGateResult,
  ScenarioActor,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "./types.js";
import { executeScenarioPlan } from "./scenario/index.js";
import { executeCommand } from "./command.js";
import { runDeterministicValidation, isReadyForPlaywrightSmoke } from "./validation/index.js";
import { buildDeployEnv } from "./validation/chainSigner.js";
import { isValidatorEnabled, runEvaluation } from "./evaluation.js";
import { specHasEval } from "./sliceSelection.js";
import {
  createDevServerSession,
  loadDevServerConfig,
  type DevServerSession,
} from "./validation/devServer.js";
import { runPlaywrightGate } from "./validation/playwrightGate.js";
import { withValidatorMcp } from "./validatorMcp.js";
import { WorkspaceWatcher } from "./workspaceWatcher.js";

/**
 * One attempt runs five stages in order:
 *
 *   GENERATE -> ASSERT -> SCENARIO -> SMOKE -> EVALUATE
 *
 * Each stage may short-circuit the rest of the attempt. That ordering is a cost
 * decision as much as a correctness one: ASSERT is cheap and deterministic, so a
 * failing build never pays for a native Hedera scenario, a dev server boot, or
 * an adversarial evaluator pass.
 */
export const STAGE_NAMES = ["GENERATE", "ASSERT", "SCENARIO", "SMOKE", "EVALUATE"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface AttemptStageContext {
  attempt: number;
  spec: TemplateSpec;
  workspacePath: string;
  layout: RunLayout;
  chainSigner?: ChainSigner;
  scenarioActors?: ScenarioActor[];
  /** Vendored eval checklist path, relative to the workspace. */
  evalRelativePath?: string;
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
export async function runAssertStage(context: AttemptStageContext): Promise<ValidationResult> {
  return runDeterministicValidation(context.workspacePath, context.spec, {
    installCachePath: path.join(context.layout.cacheDirectory, "install-fingerprint.txt"),
  });
}

/**
 * SCENARIO — harness-owned native Hedera steps against testnet, then mirror oracles.
 * No agent. Failures skip SMOKE and EVALUATE.
 */
export async function runScenarioStage(context: AttemptStageContext): Promise<ValidationResult> {
  const config = context.spec.scenarios;
  if (!config?.enabled) {
    return { passed: true, findings: [], commandResults: [] };
  }
  if (!context.scenarioActors || context.scenarioActors.length === 0) {
    return {
      passed: false,
      findings: [
        {
          id: "scenario:actors-missing",
          category: "scenario",
          message: "SCENARIO is enabled but no actors were provisioned.",
        },
      ],
      commandResults: [],
    };
  }

  const result = await executeScenarioPlan(config.plan, context.scenarioActors);
  await writeJsonFile(
    path.join(context.layout.logsDirectory, `scenario-attempt-${context.attempt}.json`),
    result,
  );
  await appendHarnessLog(context.layout.jsonlLogPath, {
    type: "scenario_finished",
    timestamp: new Date().toISOString(),
    attempt: context.attempt,
    passed: result.passed,
    stepCount: result.steps.length,
    assertionCount: result.assertions.length,
    durationMs: result.durationMs,
    infrastructureFailure: result.infrastructureFailure,
  });

  const findings: ValidationFinding[] = [];
  for (const step of result.steps) {
    if (!step.error) continue;
    findings.push({
      id: `scenario:step:${step.id}`,
      category: "scenario",
      message: `Scenario step ${step.id} (${step.kind}) failed.`,
      details: step.error,
    });
  }
  for (const [index, assertion] of result.assertions.entries()) {
    if (assertion.passed) continue;
    findings.push({
      id: `scenario:assert:${index + 1}`,
      category: "scenario",
      message: `Scenario assertion failed: ${assertion.kind}.`,
      details: assertion.detail,
    });
  }

  return {
    passed: result.passed && findings.length === 0,
    findings,
    commandResults: [],
    scenario: result,
  };
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

/** EVALUATE — adversarial validator grades the live app against the evaluate checklist. */
export async function runEvaluateStage(
  context: AttemptStageContext,
  devServer: DevServerSession,
  extraValidatorArgs: string[] = [],
): Promise<EvaluationResult> {
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

  const evaluation = await runEvaluation({
    workspacePath: context.workspacePath,
    spec: context.spec,
    attempt,
    logsDirectory: layout.logsDirectory,
    promptsDirectory: layout.promptsDirectory,
    devServer,
    chainSigner: context.chainSigner,
    evalRelativePath: context.evalRelativePath,
    extraArgs: extraValidatorArgs,
  });

  await writeJsonFile(
    path.join(layout.logsDirectory, `evaluation-attempt-${attempt}.json`),
    evaluation,
  );
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "validator_finished",
    timestamp: new Date().toISOString(),
    attempt,
    passed: evaluation.passed,
    findingCount: evaluation.findings.length,
    durationMs: evaluation.durationMs,
    infrastructureFailure: evaluation.infrastructureFailure,
    infrastructureFailureReason: evaluation.infrastructureFailureReason,
  });

  return evaluation;
}

/**
 * Run ASSERT, then SMOKE (and EVALUATE when configured) if the cheap gates left
 * nothing open.
 *
 * Any configured Playwright path boots one DevServerSession; SMOKE and EVALUATE
 * borrow it. ASSERT never owns a server.
 */
export async function runValidationStages(
  context: AttemptStageContext,
  generateFinding?: ValidationFinding,
): Promise<ValidationResult> {
  const hasPlaywright = Boolean(context.spec.validators.playwrightPath);
  const runEvaluate =
    hasPlaywright && isValidatorEnabled(context.spec) && specHasEval(context.spec);

  logStage("ASSERT");
  const deterministic = await runAssertStage(context);

  // Generator exit/timeout findings are recorded but must not fail ASSERT or skip
  // SMOKE/EVALUATE — Cursor often hangs after finishing work; the gates decide pass.
  let validation = mergeGenerateFinding(deterministic, generateFinding);

  if (!isReadyForPlaywrightSmoke(validation)) {
    logStage("SCENARIO", "skipped — deterministic gates are not clean");
    logStage("SMOKE", "skipped — deterministic gates are not clean");
    return { ...validation, passed: false };
  }

  if (context.spec.scenarios?.enabled) {
    logStage("SCENARIO");
    const scenario = await runScenarioStage(context);
    validation = {
      ...validation,
      findings: [...validation.findings, ...scenario.findings],
      scenario: scenario.scenario,
      passed: validation.passed && scenario.passed,
    };
    if (!scenario.passed) {
      logStage("SMOKE", "skipped — scenario gate failed");
      return { ...validation, passed: false };
    }
  } else {
    logStage("SCENARIO", "skipped — not configured");
  }
  if (!hasPlaywright) {
    return validation;
  }

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
    if (!runEvaluate) {
      return afterSmoke;
    }

    // MCP delivery is EVALUATE-only: Cursor's .cursor/mcp.json snapshot must not
    // span deploy/boot/SMOKE (longer blast radius if the process is killed).
    // Must `await` — bare `return promise` runs `finally` (and stops the server)
    // before EVALUATE, which is exactly the SMOKE-green / EVALUATE-refused bug.
    return await withValidatorMcp(
      {
        agent: context.spec.agent,
        workspacePath: context.workspacePath,
        artifactsDirectory: context.layout.runDirectory,
      },
      async mcpArgs => {
        const evaluation = await runEvaluateStage(context, devServer!, mcpArgs);
        return evaluation.passed
          ? { ...afterSmoke, evaluation }
          : {
              ...afterSmoke,
              passed: false,
              findings: [...afterSmoke.findings, ...evaluation.findings],
              evaluation,
            };
      },
    );
  } finally {
    await devServer?.stop();
  }
}

/**
 * Attach a GENERATE process finding without failing ASSERT.
 * `isReadyForPlaywrightSmoke` already ignores `category: "agent"`; after SMOKE,
 * `passed` ignores agent findings too. Skipping SMOKE solely because GENERATE
 * timed out left green work ungraded (Cursor hang-after-done).
 */
export function mergeGenerateFinding(
  deterministic: ValidationResult,
  generateFinding?: ValidationFinding,
): ValidationResult {
  if (!generateFinding) return deterministic;
  return {
    ...deterministic,
    findings: [generateFinding, ...deterministic.findings],
    passed: deterministic.passed,
  };
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

export type { CommandExecutionResult };
