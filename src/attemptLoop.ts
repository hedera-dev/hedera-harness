import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { buildContinuePrompt, buildGeneratorPrompt, buildRepairPrompt } from "./promptBuilder.js";
import {
  appendHarnessLog,
  appendHarnessNote,
  type RunLayout,
  writeJsonFile,
  writePromptFile,
  writeStatusFile,
} from "./runArtifacts.js";
import type { VendoredContext } from "./contextVendor.js";
import type { VendoredSkill } from "./skillVendor.js";
import type { AgentProgress } from "./agentStreamLogger.js";
import type {
  BlindIntegrityResult,
  ChainSigner,
  RunReport,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "./types.js";
import { auditOracleAccess } from "./oracleAudit.js";
import {
  commitWorkspaceAttempt,
  type WorkspaceGitCommitResult,
} from "./workspaceGit.js";
import { executeCommand } from "./command.js";
import { runDeterministicValidation } from "./validation/index.js";
import { buildDeployEnv } from "./validation/chainSigner.js";
import { isValidatorEnabled, runSemanticValidation } from "./semanticValidator.js";
import { createDevServerSession, loadDevServerConfig } from "./validation/devServer.js";
import { runPlaywrightGate } from "./validation/playwrightGate.js";
import { WorkspaceWatcher } from "./workspaceWatcher.js";

export interface AttemptLoopSeedInfo {
  workspacePath: string;
  repo: string;
  ref: string;
  commitSha: string;
}

export interface AttemptLoopInput {
  layout: RunLayout;
  spec: TemplateSpec;
  specPath: string;
  projectRoot: string;
  maxAttempts: number;
  isContinue: boolean;
  cycle?: number;
  startingAttempt: number;
  startedAt: Date;
  seedResult: AttemptLoopSeedInfo;
  vendoredSkills: VendoredSkill[];
  vendoredContext: VendoredContext;
  chainSigner?: ChainSigner;
  /**
   * Optional commit hook (extend uses a distinct strategy later).
   * Defaults to isolated-workspace `commitWorkspaceAttempt`.
   */
  commitAttempt?: (
    workspacePath: string,
    attempt: number,
    passed: boolean,
    findingCount: number,
  ) => Promise<WorkspaceGitCommitResult>;
}

export async function runAttemptLoop(input: AttemptLoopInput): Promise<RunReport> {
  const {
    layout,
    spec,
    specPath,
    projectRoot,
    maxAttempts,
    isContinue,
    cycle,
    startedAt,
    seedResult,
    vendoredSkills,
    vendoredContext,
    chainSigner,
  } = input;

  const generator = new CommandAgentProvider(spec.generator);
  const commitAttempt = input.commitAttempt ?? commitWorkspaceAttempt;

  let attempts = input.startingAttempt - 1;
  let attemptsThisCycle = 0;
  let validation: ValidationResult = {
    passed: false,
    findings: [
      {
        id: "generator-not-run",
        category: "agent",
        message: "Generator did not complete a successful attempt.",
      },
    ],
    commandResults: [],
  };
  let latestPrompt = isContinue
    ? await buildContinuePrompt(spec, cycle!, vendoredSkills)
    : await buildGeneratorPrompt(spec, 1, vendoredSkills);
  let blindIntegrity: BlindIntegrityResult = {
    passed: true,
    findings: [],
    scannedLogs: [],
  };

  while (attemptsThisCycle < maxAttempts) {
    attempts += 1;
    attemptsThisCycle += 1;
    const isFreshFirst = !isContinue && attempts === 1;
    const isContinueFirst = isContinue && attemptsThisCycle === 1;
    const promptFileName = isFreshFirst
      ? `generator-attempt-${attempts}.txt`
      : isContinueFirst
        ? `continue-cycle-${cycle}-attempt-${attempts}.txt`
        : `repair-attempt-${attempts}.txt`;
    const promptPath = path.join(layout.promptsDirectory, promptFileName);
    await writePromptFile(promptPath, latestPrompt);

    if (isContinueFirst) {
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "continue_started",
        timestamp: new Date().toISOString(),
        attempt: attempts,
        cycle: cycle!,
        promptPath,
      });
    } else {
      await appendHarnessLog(layout.jsonlLogPath, {
        type: isFreshFirst ? "generator_started" : "repair_started",
        timestamp: new Date().toISOString(),
        attempt: attempts,
        promptPath,
      });
    }
    await writeStatusFile(layout.runDirectory, {
      phase: isFreshFirst || isContinueFirst ? "generator_running" : "repair_running",
      attempt: attempts,
      cycle,
      attemptsThisCycle,
      promptPath,
    });
    logPhase(
      isFreshFirst
        ? `Generator attempt ${attempts} started`
        : isContinueFirst
          ? `Continue cycle ${cycle} attempt ${attempts} started`
          : `Repair attempt ${attempts} started`,
      "Tail logs/generator-attempt-N.activity.log and logs/workspace-activity.log",
    );

    const agentLogPath = path.join(layout.logsDirectory, `generator-attempt-${attempts}.log`);
    const agentActivityLogPath = path.join(
      layout.logsDirectory,
      `generator-attempt-${attempts}.activity.log`,
    );
    const workspaceActivityLogPath = path.join(
      layout.logsDirectory,
      `workspace-attempt-${attempts}.activity.log`,
    );
    const agentStartedAt = Date.now();
    let latestProgress: AgentProgress = {
      lastActivity: "agent process spawned",
      toolCallsStarted: 0,
      toolCallsCompleted: 0,
    };

    const workspaceWatcher = new WorkspaceWatcher(
      seedResult.workspacePath,
      workspaceActivityLogPath,
      async summary => {
        latestProgress = { ...latestProgress, lastActivity: summary };
        await writeStatusFile(
          layout.runDirectory,
          buildAgentStatus(attempts, agentStartedAt, latestProgress, {
            activityLogPath: agentActivityLogPath,
            workspaceActivityLogPath,
          }),
        );
      },
    );
    await workspaceWatcher.start();

    const heartbeat = setInterval(() => {
      void writeStatusFile(
        layout.runDirectory,
        buildAgentStatus(attempts, agentStartedAt, latestProgress, {
          activityLogPath: agentActivityLogPath,
          workspaceActivityLogPath,
        }),
      );
      console.log(
        `[hedera-harness] agent still running (${Math.round((Date.now() - agentStartedAt) / 1000)}s) — ${latestProgress.lastActivity}`,
      );
    }, 15_000);

    let agentResult;
    try {
      agentResult = await generator.run({
        workspacePath: seedResult.workspacePath,
        prompt: latestPrompt,
        attempt: attempts,
        role: "generator",
        timeoutMs: spec.generator.timeoutMs,
        logPath: agentLogPath,
        activityLogPath: agentActivityLogPath,
        onProgress: async progress => {
          latestProgress = progress;
          await writeStatusFile(
            layout.runDirectory,
            buildAgentStatus(attempts, agentStartedAt, progress, {
              activityLogPath: agentActivityLogPath,
              workspaceActivityLogPath,
            }),
          );
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      agentResult = {
        exitCode: 127,
        stdout: "",
        stderr: message,
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
      attempt: attempts,
      exitCode: agentResult.exitCode,
      durationMs: agentResult.durationMs,
      timedOut: agentResult.timedOut,
    });

    blindIntegrity = await auditOracleAccess({
      workspacePath: seedResult.workspacePath,
      seedRepo: spec.seed.repo,
      harnessProjectRoot: projectRoot,
      runDirectory: layout.runDirectory,
      activityLogPath: agentActivityLogPath,
      rawLogPath: agentLogPath,
    });
    const oracleAuditPath = path.join(layout.logsDirectory, `oracle-audit-attempt-${attempts}.json`);
    await writeJsonFile(oracleAuditPath, blindIntegrity);
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "oracle_audit_finished",
      timestamp: new Date().toISOString(),
      attempt: attempts,
      passed: blindIntegrity.passed,
      findingCount: blindIntegrity.findings.length,
    });

    if (!blindIntegrity.passed) {
      logPhase(
        "Oracle audit failed (informational)",
        `${blindIntegrity.findings.length} peeking finding(s) — does not affect harness pass/fail`,
      );
    }

    if (agentResult.exitCode !== 0) {
      const agentFinding = {
        id: agentResult.timedOut ? `generator-timeout:${attempts}` : `generator-exit:${attempts}`,
        category: "agent" as const,
        message: agentResult.timedOut
          ? `Generator agent timed out after ${Math.round(agentResult.durationMs / 1000)}s`
          : `Generator agent exited with code ${agentResult.exitCode ?? "null"}`,
        details: truncate(agentResult.stderr || agentResult.stdout),
      };
      validation = await runAttemptValidation({
        workspacePath: seedResult.workspacePath,
        spec,
        runDirectory: layout.runDirectory,
        cacheDirectory: layout.cacheDirectory,
        attempts,
        agentFinding,
        jsonlLogPath: layout.jsonlLogPath,
        chainSigner,
      });
    } else {
      validation = await runAttemptValidation({
        workspacePath: seedResult.workspacePath,
        spec,
        runDirectory: layout.runDirectory,
        cacheDirectory: layout.cacheDirectory,
        attempts,
        logsDirectory: layout.logsDirectory,
        promptsDirectory: layout.promptsDirectory,
        jsonlLogPath: layout.jsonlLogPath,
        chainSigner,
      });
    }

    const validationLogPath = path.join(layout.logsDirectory, `validation-attempt-${attempts}.json`);
    await writeJsonFile(validationLogPath, validation);
    if (validation.playwrightGate) {
      const playwrightGateLogPath = path.join(
        layout.logsDirectory,
        `playwright-gate-attempt-${attempts}.json`,
      );
      await writeJsonFile(playwrightGateLogPath, validation.playwrightGate);
    }

    await appendHarnessLog(layout.jsonlLogPath, {
      type: "validation_finished",
      timestamp: new Date().toISOString(),
      attempt: attempts,
      passed: validation.passed,
      findingCount: validation.findings.length,
    });

    if (!(validation.passed && !validation.semanticValidation)) {
      await writeStatusFile(layout.runDirectory, {
        phase: "validated",
        attempt: attempts,
        passed: validation.passed,
        findingCount: validation.findings.length,
        semanticPassed: validation.semanticValidation?.passed,
        infrastructureFailure: validation.semanticValidation?.infrastructureFailure ?? false,
      });
    }

    if (validation.semanticValidation) {
      logPhase(
        `Attempt ${attempts} semantic validation ${validation.semanticValidation.passed ? "passed" : "failed"}`,
        validation.semanticValidation.passed
          ? validation.semanticValidation.verdict?.summary
          : validation.semanticValidation.infrastructureFailure
            ? `infrastructure: ${validation.semanticValidation.infrastructureFailureReason}`
            : `${validation.semanticValidation.findings.length} finding(s)`,
      );
    } else {
      logPhase(
        `Attempt ${attempts} deterministic validation ${validation.passed ? "passed" : "failed"}`,
        validation.passed
          ? validation.playwrightGate
            ? `playwright gate passed (${validation.playwrightGate.routes.length} routes)`
            : undefined
          : `${validation.findings.length} finding(s)`,
      );
    }

    if (validation.semanticValidation?.infrastructureFailure) {
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "validator_infra_aborted",
        timestamp: new Date().toISOString(),
        attempt: attempts,
        reason:
          validation.semanticValidation.infrastructureFailureReason ??
          "semantic infrastructure failure",
      });
      await appendHarnessNote(
        layout.notesLogPath,
        `Attempt ${attempts} semantic infrastructure abort`,
        [
          "Repair loop aborted: failure is harness/agent tooling, not the generated app.",
          validation.semanticValidation.infrastructureFailureReason ?? "(no reason)",
          ...validation.semanticValidation.findings.map(
            finding => `- [${finding.category}] ${finding.message}`,
          ),
        ].join("\n"),
      );
      logPhase(
        "Aborting repair loop after semantic infrastructure failure",
        validation.semanticValidation.infrastructureFailureReason,
      );

      const gitCommit = await commitAttempt(
        seedResult.workspacePath,
        attempts,
        false,
        validation.findings.length,
      );
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "workspace_git_committed",
        timestamp: new Date().toISOString(),
        attempt: attempts,
        committed: gitCommit.committed,
        commitSha: gitCommit.commitSha,
        message: gitCommit.message,
      });
      break;
    }

    await appendHarnessNote(
      layout.notesLogPath,
      `Attempt ${attempts} validation`,
      validation.passed
        ? validation.semanticValidation
          ? "Deterministic, Playwright gate, and semantic validation passed."
          : "Deterministic validation passed."
        : validation.findings.map(finding => `- [${finding.category}] ${finding.message}`).join("\n"),
    );

    const gitCommit = await commitAttempt(
      seedResult.workspacePath,
      attempts,
      validation.passed,
      validation.findings.length,
    );
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "workspace_git_committed",
      timestamp: new Date().toISOString(),
      attempt: attempts,
      committed: gitCommit.committed,
      commitSha: gitCommit.commitSha,
      message: gitCommit.message,
    });
    if (gitCommit.committed && gitCommit.commitSha) {
      logPhase(`Workspace committed`, `${gitCommit.message} @ ${gitCommit.commitSha.slice(0, 8)}`);
    } else {
      logPhase("Workspace unchanged", "no git commit needed for this attempt");
    }

    if (validation.passed) {
      break;
    }

    if (attemptsThisCycle < maxAttempts) {
      latestPrompt = await buildRepairPrompt(spec, validation.findings, attempts + 1, vendoredContext);
    }
  }

  const finishedAt = new Date();
  const report: RunReport = {
    specName: spec.name,
    specPath,
    runDirectory: layout.runDirectory,
    workspacePath: seedResult.workspacePath,
    seedRepo: seedResult.repo,
    seedRef: seedResult.ref,
    seedCommitSha: seedResult.commitSha,
    attempts,
    maxAttempts,
    cycle,
    attemptsThisCycle,
    passed: validation.passed,
    blindIntegrity,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    validation,
    semanticValidation: validation.semanticValidation,
  };

  await writeJsonFile(layout.reportPath, report);
  if (isContinue && cycle !== undefined) {
    await writeJsonFile(path.join(layout.reportsDirectory, `cycle-${cycle}.json`), report);
  }

  await appendHarnessLog(layout.jsonlLogPath, {
    type: "run_finished",
    timestamp: finishedAt.toISOString(),
    passed: report.passed,
    attempts: report.attempts,
    reportPath: layout.reportPath,
  });

  await appendHarnessNote(
    layout.notesLogPath,
    isContinue ? `Run continued finished: ${spec.name} (cycle ${cycle})` : `Run finished: ${spec.name}`,
    [
      report.passed
        ? `Passed after ${report.attemptsThisCycle ?? report.attempts} attempt(s) this kick. Report: ${layout.reportPath}`
        : `Failed after ${report.attemptsThisCycle ?? report.attempts} attempt(s) this kick. Report: ${layout.reportPath}`,
      isContinue ? `Total attempts in project: ${report.attempts}` : undefined,
      formatBlindIntegritySummary(report.blindIntegrity),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );
  await writeStatusFile(layout.runDirectory, {
    phase: "finished",
    passed: report.passed,
    blindIntegrityPassed: report.blindIntegrity.passed,
    attempts: report.attempts,
    reportPath: layout.reportPath,
  });
  logPhase(
    `Run finished: ${report.passed ? "PASSED" : "FAILED"}`,
    report.passed && !report.blindIntegrity.passed
      ? `${layout.reportPath} — validation passed but oracle audit detected peeking`
      : `${layout.reportPath} (oracleAudit=${report.blindIntegrity.passed ? "passed" : "failed"})`,
  );
  if (report.passed && !report.blindIntegrity.passed) {
    console.log(formatBlindIntegritySummary(report.blindIntegrity));
  }

  return report;
}

export async function runAttemptValidation(input: {
  workspacePath: string;
  spec: TemplateSpec;
  runDirectory: string;
  cacheDirectory?: string;
  attempts: number;
  logsDirectory?: string;
  promptsDirectory?: string;
  jsonlLogPath?: string;
  agentFinding?: ValidationFinding;
  chainSigner?: ChainSigner;
}): Promise<ValidationResult> {
  const installCachePath = path.join(
    input.cacheDirectory ?? path.join(input.runDirectory, "cache"),
    "install-fingerprint.txt",
  );
  const useSharedDevServer =
    isValidatorEnabled(input.spec) && Boolean(input.spec.validators.playwrightPath);

  const detOptions = {
    skipPlaywrightGate: useSharedDevServer,
    installCachePath,
  };

  let validation: ValidationResult;
  if (input.agentFinding) {
    const deterministic = await runDeterministicValidation(input.workspacePath, input.spec, detOptions);
    validation = {
      passed: false,
      findings: [input.agentFinding, ...deterministic.findings],
      commandResults: deterministic.commandResults,
      playwrightGate: deterministic.playwrightGate,
    };
  } else {
    validation = await runDeterministicValidation(input.workspacePath, input.spec, detOptions);
  }

  const tier01Passed = validation.findings.filter(finding => finding.category !== "agent").length === 0;
  if (!useSharedDevServer || !tier01Passed || input.agentFinding) {
    return validation;
  }

  // Optional on-chain deploy hook (Solidity templates) before starting the app.
  if (input.chainSigner && input.spec.chainValidation?.deploy?.commands.length) {
    const deployFindings = await runChainDeployCommands(
      input.workspacePath,
      input.spec,
      input.chainSigner,
    );
    if (deployFindings.length > 0) {
      validation = {
        ...validation,
        passed: false,
        findings: [...validation.findings, ...deployFindings],
      };
      return validation;
    }
  }

  const playwrightPath = input.spec.validators.playwrightPath!;
  let devSession = null;
  try {
    const serverConfig = await loadDevServerConfig(playwrightPath);
    devSession = await createDevServerSession(input.workspacePath, serverConfig, "runtime");

    console.log("[hedera-harness] Running thin Playwright gate (shared dev server)...");
    const gate = await runPlaywrightGate(input.workspacePath, playwrightPath, devSession);
    validation.playwrightGate = gate.result;
    validation.findings.push(...gate.findings);
    validation.passed = validation.findings.filter(finding => finding.category !== "agent").length === 0;

    if (!validation.passed || !input.logsDirectory || !input.promptsDirectory) {
      return validation;
    }

    const validatorPromptPath = path.join(input.promptsDirectory, `validator-attempt-${input.attempts}.txt`);
    if (input.jsonlLogPath) {
      await appendHarnessLog(input.jsonlLogPath, {
        type: "validator_started",
        timestamp: new Date().toISOString(),
        attempt: input.attempts,
        promptPath: validatorPromptPath,
        serverUrl: devSession.url,
      });
    }
    logPhase(`Validator attempt ${input.attempts} started`, devSession.url);

    const semanticValidation = await runSemanticValidation({
      workspacePath: input.workspacePath,
      spec: input.spec,
      attempt: input.attempts,
      logsDirectory: input.logsDirectory,
      promptsDirectory: input.promptsDirectory,
      devServer: devSession,
      chainSigner: input.chainSigner,
    });

    const semanticLogPath = path.join(
      input.logsDirectory,
      `semantic-validation-attempt-${input.attempts}.json`,
    );
    await writeJsonFile(semanticLogPath, semanticValidation);

    if (input.jsonlLogPath) {
      await appendHarnessLog(input.jsonlLogPath, {
        type: "validator_finished",
        timestamp: new Date().toISOString(),
        attempt: input.attempts,
        passed: semanticValidation.passed,
        findingCount: semanticValidation.findings.length,
        durationMs: semanticValidation.durationMs,
        infrastructureFailure: semanticValidation.infrastructureFailure,
        infrastructureFailureReason: semanticValidation.infrastructureFailureReason,
      });
    }

    if (!semanticValidation.passed) {
      validation = {
        ...validation,
        passed: false,
        findings: [...validation.findings, ...semanticValidation.findings],
        semanticValidation,
      };
    } else {
      validation = {
        ...validation,
        semanticValidation,
      };
    }
  } finally {
    await devSession?.stop();
  }

  return validation;
}

export function logPhase(title: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`[hedera-harness] ${title}${suffix}`);
}

export function formatBlindIntegritySummary(blindIntegrity: BlindIntegrityResult): string {
  if (blindIntegrity.passed) {
    return "Oracle audit: passed (no peeking detected).";
  }

  const findings = blindIntegrity.findings
    .map(finding => `- ${finding.message}${finding.path ? ` (${finding.path})` : ""}`)
    .join("\n");

  return [
    `Oracle audit: FAILED — agent may have peeked outside the workspace (${blindIntegrity.findings.length} finding(s)).`,
    "This does not fail the harness when deterministic validation passes.",
    findings,
  ].join("\n");
}

async function runChainDeployCommands(
  workspacePath: string,
  spec: TemplateSpec,
  chainSigner: ChainSigner,
): Promise<ValidationFinding[]> {
  const commands = spec.chainValidation?.deploy?.commands ?? [];
  if (commands.length === 0) return [];

  const env = buildDeployEnv(chainSigner, spec.chainValidation?.expose.envVars ?? []);
  const findings: ValidationFinding[] = [];

  for (const commandConfig of commands) {
    logPhase(`Chain deploy: ${commandConfig.name}`, commandConfig.command);
    const result = await executeCommand({
      command: commandConfig.command,
      cwd: workspacePath,
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

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function buildAgentStatus(
  attempt: number,
  startedAtMs: number,
  progress: AgentProgress,
  logs: { activityLogPath: string; workspaceActivityLogPath: string },
): Record<string, unknown> {
  return {
    phase: "generator_running",
    attempt,
    elapsedSeconds: Math.round((Date.now() - startedAtMs) / 1000),
    lastActivity: progress.lastActivity,
    toolCallsStarted: progress.toolCallsStarted,
    toolCallsCompleted: progress.toolCallsCompleted,
    sessionId: progress.sessionId,
    activityLogPath: logs.activityLogPath,
    workspaceActivityLogPath: logs.workspaceActivityLogPath,
  };
}
