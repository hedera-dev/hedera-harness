import path from "node:path";
import {
  appendHarnessLog,
  appendHarnessNote,
  type RunLayout,
  writeJsonFile,
  writePromptFile,
  writeStatusFile,
} from "./runArtifacts.js";
import { logStage } from "./attemptStages.js";
import { findingIds, formatFindingDelta, type FindingDelta } from "./findingsLifecycle.js";
import type { AttemptLoopInput } from "./attemptLoop.js";
import type { RunReport, TemplateSpec, ValidationResult } from "./types.js";

/**
 * Artifact and console reporting for one attempt.
 *
 * Split from the loop so `runAttemptLoop` reads as the four stages and their
 * short-circuits, rather than as stage calls buried in log/status/notes writes.
 */
export type AttemptKind = "generate" | "continue" | "repair";

export function attemptKind(isContinue: boolean, attempt: number, attemptsThisCycle: number): AttemptKind {
  if (!isContinue && attempt === 1) return "generate";
  if (isContinue && attemptsThisCycle === 1) return "continue";
  return "repair";
}

export async function announceAttempt(input: {
  layout: RunLayout;
  kind: AttemptKind;
  attempt: number;
  cycle?: number;
  attemptsThisCycle: number;
  prompt: string;
}): Promise<void> {
  const { layout, kind, attempt, cycle, attemptsThisCycle, prompt } = input;
  const fileName =
    kind === "generate"
      ? `generator-attempt-${attempt}.txt`
      : kind === "continue"
        ? `continue-cycle-${cycle}-attempt-${attempt}.txt`
        : `repair-attempt-${attempt}.txt`;
  const promptPath = path.join(layout.promptsDirectory, fileName);
  await writePromptFile(promptPath, prompt);

  if (kind === "continue") {
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "continue_started",
      timestamp: new Date().toISOString(),
      attempt,
      cycle: cycle!,
      promptPath,
    });
  } else {
    await appendHarnessLog(layout.jsonlLogPath, {
      type: kind === "generate" ? "generator_started" : "repair_started",
      timestamp: new Date().toISOString(),
      attempt,
      promptPath,
    });
  }

  await writeStatusFile(layout.runDirectory, {
    phase: kind === "repair" ? "repair_running" : "generator_running",
    stage: "GENERATE",
    attempt,
    cycle,
    attemptsThisCycle,
    promptPath,
  });

  logStage(
    "GENERATE",
    kind === "continue"
      ? `continue cycle ${cycle}, attempt ${attempt}`
      : kind === "repair"
        ? `repair, attempt ${attempt}`
        : `attempt ${attempt}`,
  );
}

export async function recordAttemptResult(input: {
  layout: RunLayout;
  attempt: number;
  validation: ValidationResult;
  delta: FindingDelta;
}): Promise<void> {
  const { layout, attempt, validation, delta } = input;

  await writeJsonFile(
    path.join(layout.logsDirectory, `validation-attempt-${attempt}.json`),
    validation,
  );
  if (validation.playwrightGate) {
    await writeJsonFile(
      path.join(layout.logsDirectory, `playwright-gate-attempt-${attempt}.json`),
      validation.playwrightGate,
    );
  }

  await appendHarnessLog(layout.jsonlLogPath, {
    type: "validation_finished",
    timestamp: new Date().toISOString(),
    attempt,
    passed: validation.passed,
    findingCount: delta.open.length,
    openFindingIds: delta.open,
    fixedFindingIds: delta.fixed,
    introducedFindingIds: delta.introduced,
  });

  await writeStatusFile(layout.runDirectory, {
    phase: "validated",
    attempt,
    passed: validation.passed,
    findingCount: delta.open.length,
    openFindingIds: delta.open,
    fixedFindingIds: delta.fixed,
    semanticPassed: validation.semanticValidation?.passed,
    infrastructureFailure: validation.semanticValidation?.infrastructureFailure ?? false,
  });

  const summary = validation.semanticValidation
    ? validation.semanticValidation.passed
      ? (validation.semanticValidation.verdict?.summary ?? "semantic validation passed")
      : validation.semanticValidation.infrastructureFailure
        ? `infrastructure: ${validation.semanticValidation.infrastructureFailureReason}`
        : formatFindingDelta(delta)
    : validation.passed
      ? (validation.playwrightGate
          ? `playwright gate passed (${validation.playwrightGate.routes.length} routes)`
          : "deterministic gates passed")
      : formatFindingDelta(delta);

  console.log(
    `[hedera-harness] Attempt ${attempt} ${validation.passed ? "PASSED" : "FAILED"} — ${summary}`,
  );
}

export async function abortOnInfrastructureFailure(input: {
  layout: RunLayout;
  attempt: number;
  validation: ValidationResult;
}): Promise<void> {
  const { layout, attempt, validation } = input;
  const reason =
    validation.semanticValidation?.infrastructureFailureReason ??
    "semantic infrastructure failure";

  await appendHarnessLog(layout.jsonlLogPath, {
    type: "validator_infra_aborted",
    timestamp: new Date().toISOString(),
    attempt,
    reason,
  });
  await appendHarnessNote(
    layout.notesLogPath,
    `Attempt ${attempt} semantic infrastructure abort`,
    [
      "Repair loop aborted: failure is harness/agent tooling, not the generated app.",
      reason,
      ...(validation.semanticValidation?.findings ?? []).map(
        finding => `- [${finding.category}] ${finding.message}`,
      ),
    ].join("\n"),
  );
  logPhase("Aborting repair loop after semantic infrastructure failure", reason);
}

export async function checkpoint(input: {
  layout: RunLayout;
  commitAttempt: AttemptLoopInput["commitAttempt"];
  workspacePath: string;
  attempt: number;
  validation: ValidationResult;
}): Promise<void> {
  const { layout, commitAttempt, workspacePath, attempt, validation } = input;
  const gitCommit = await commitAttempt(
    workspacePath,
    attempt,
    validation.passed,
    validation.findings,
  );
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "workspace_git_committed",
    timestamp: new Date().toISOString(),
    attempt,
    committed: gitCommit.committed,
    commitSha: gitCommit.commitSha,
    message: gitCommit.message,
  });
  if (gitCommit.committed && gitCommit.commitSha) {
    logPhase("Workspace committed", `${gitCommit.message} @ ${gitCommit.commitSha.slice(0, 8)}`);
  } else {
    logPhase("Workspace unchanged", "no git commit needed for this attempt");
  }
}

export async function finishRun(input: {
  layout: RunLayout;
  spec: TemplateSpec;
  specPath: string;
  workspacePath: string;
  attempts: number;
  attemptsThisCycle: number;
  maxAttempts: number;
  isContinue: boolean;
  cycle?: number;
  startedAt: Date;
  validation: ValidationResult;
  delta: FindingDelta;
}): Promise<RunReport> {
  const { layout, spec, isContinue, cycle, validation, delta } = input;
  const finishedAt = new Date();

  const report: RunReport = {
    specName: spec.name,
    specPath: input.specPath,
    runDirectory: layout.runDirectory,
    workspacePath: input.workspacePath,
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    cycle,
    attemptsThisCycle: input.attemptsThisCycle,
    passed: validation.passed,
    openFindingIds: delta.open,
    fixedFindingIds: delta.fixed,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
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
    isContinue
      ? `Run continued finished: ${spec.name} (cycle ${cycle})`
      : `Run finished: ${spec.name}`,
    [
      `${report.passed ? "Passed" : "Failed"} after ${report.attemptsThisCycle ?? report.attempts} attempt(s) this kick.`,
      `Findings: ${formatFindingDelta(delta)}`,
      `Report: ${layout.reportPath}`,
      isContinue ? `Total attempts in project: ${report.attempts}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );

  await writeStatusFile(layout.runDirectory, {
    phase: "finished",
    passed: report.passed,
    attempts: report.attempts,
    openFindingIds: delta.open,
    reportPath: layout.reportPath,
  });

  logPhase(
    `Run finished: ${report.passed ? "PASSED" : "FAILED"}`,
    `${formatFindingDelta(delta)} — ${layout.reportPath}`,
  );

  return report;
}

export function notRunYet(): ValidationResult {
  return {
    passed: false,
    findings: [
      {
        id: "generator-not-run",
        category: "agent",
        message: "Generator did not complete a successful attempt.",
        status: "open",
      },
    ],
    commandResults: [],
  };
}

export function logPhase(title: string, detail?: string): void {
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`[hedera-harness] ${title}${suffix}`);
}

export { findingIds };
