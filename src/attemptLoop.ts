import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import {
  buildSessionContinuePrompt,
  buildSessionPrompt,
  buildSessionRepairPrompt,
} from "./promptBuilder.js";
import { appendHarnessNote, type RunLayout } from "./runArtifacts.js";
import { runGenerateStage, runValidationStages, type AttemptStageContext } from "./attemptStages.js";
import {
  announceAttempt,
  attemptKind,
  checkpoint,
  abortOnInfrastructureFailure,
  finishRun,
  logPhase,
  notRunYet,
  recordAttemptResult,
} from "./attemptReporting.js";
import {
  applyFindingStatus,
  computeFindingDelta,
  findingIds,
  formatFindingDelta,
  type FindingDelta,
} from "./findingsLifecycle.js";
import type { VendoredContext } from "./contextVendor.js";
import type { VendoredSkill } from "./skillVendor.js";
import type {
  ChainSigner,
  RunReport,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "./types.js";
import type { CheckpointCommitResult } from "./harnessGit.js";

/** Shared per-run session metadata passed through the attempt loop. */
export interface SessionContext {
  layout: RunLayout;
  spec: TemplateSpec;
  specPath: string;
  /** The project directory the agent edits in place. */
  workspacePath: string;
  vendoredSkills: VendoredSkill[];
  vendoredContext: VendoredContext;
  chainSigner?: ChainSigner;
}

/** Prompt + Playwright MCP wiring for the in-place run loop. */
export interface AttemptPromptStrategy {
  buildInitialPrompt(isContinue: boolean, cycle: number | undefined): Promise<string>;
  buildRepairPrompt(findings: ValidationFinding[], nextAttempt: number): Promise<string>;
}

export interface AttemptLoopInput {
  layout: RunLayout;
  spec: TemplateSpec;
  specPath: string;
  maxAttempts: number;
  isContinue: boolean;
  cycle?: number;
  startingAttempt: number;
  startedAt: Date;
  /** The project directory the agent edits in place. */
  workspacePath: string;
  vendoredSkills: VendoredSkill[];
  vendoredContext: VendoredContext;
  chainSigner?: ChainSigner;
  /** Finding ids still open when the previous cycle stopped, for delta reporting. */
  previousOpenFindingIds?: string[];
  /** Exclusion-safe checkpoint commit hook (never stages runtime or secret paths). */
  commitAttempt: (
    workspacePath: string,
    attempt: number,
    passed: boolean,
    findings: ValidationFinding[],
  ) => Promise<CheckpointCommitResult>;
  /** Override the default session prompt strategy (tests). */
  promptStrategy?: AttemptPromptStrategy;
}

export function createSessionPromptStrategy(
  session: Pick<SessionContext, "spec" | "vendoredSkills" | "vendoredContext">,
): AttemptPromptStrategy {
  const { spec, vendoredSkills, vendoredContext } = session;
  return {
    async buildInitialPrompt(isContinue, cycle) {
      return isContinue
        ? buildSessionContinuePrompt(spec, cycle!, vendoredSkills, vendoredContext)
        : buildSessionPrompt(spec, 1, vendoredSkills, vendoredContext);
    },
    async buildRepairPrompt(findings, nextAttempt) {
      return buildSessionRepairPrompt(spec, findings, nextAttempt, vendoredContext);
    },
  };
}

/** In-place project-centric `run` attempt loop. */
export async function runSessionAttemptLoop(input: AttemptLoopInput): Promise<RunReport> {
  return runAttemptLoop({
    ...input,
    promptStrategy: input.promptStrategy ?? createSessionPromptStrategy(input),
  });
}

export async function runAttemptLoop(input: AttemptLoopInput): Promise<RunReport> {
  const {
    layout,
    spec,
    specPath,
    maxAttempts,
    isContinue,
    cycle,
    startedAt,
    workspacePath,
    vendoredContext,
    chainSigner,
    commitAttempt,
  } = input;

  const generator = new CommandAgentProvider(spec.generator);
  const promptStrategy = input.promptStrategy ?? createSessionPromptStrategy(input);

  let attempts = input.startingAttempt - 1;
  let attemptsThisCycle = 0;
  let validation: ValidationResult = notRunYet();
  let latestPrompt = await promptStrategy.buildInitialPrompt(isContinue, cycle);
  let openFindingIds = input.previousOpenFindingIds ?? [];
  let previousFindings: ValidationFinding[] = [];
  let delta: FindingDelta = { open: openFindingIds, fixed: [], introduced: [] };

  while (attemptsThisCycle < maxAttempts) {
    attempts += 1;
    attemptsThisCycle += 1;

    const context: AttemptStageContext = {
      attempt: attempts,
      spec,
      workspacePath,
      layout,
      chainSigner,
      contractRelativePath: vendoredContext.contractRelativePath,
    };

    const kind = attemptKind(isContinue, attempts, attemptsThisCycle);
    await announceAttempt({ layout, kind, attempt: attempts, cycle, attemptsThisCycle, prompt: latestPrompt });

    const generate = await runGenerateStage(context, {
      generator,
      prompt: latestPrompt,
      agentLogPath: path.join(layout.logsDirectory, `generator-attempt-${attempts}.log`),
      agentActivityLogPath: path.join(
        layout.logsDirectory,
        `generator-attempt-${attempts}.activity.log`,
      ),
      workspaceActivityLogPath: path.join(
        layout.logsDirectory,
        `workspace-attempt-${attempts}.activity.log`,
      ),
    });

    validation = await runValidationStages(context, generate.finding);

    delta = computeFindingDelta(openFindingIds, validation.findings);
    validation.findings = applyFindingStatus(validation.findings, delta, previousFindings);
    previousFindings = validation.findings;
    openFindingIds = delta.open;

    await recordAttemptResult({ layout, attempt: attempts, validation, delta });

    if (validation.semanticValidation?.infrastructureFailure) {
      await abortOnInfrastructureFailure({ layout, attempt: attempts, validation });
      await checkpoint({ layout, commitAttempt, workspacePath, attempt: attempts, validation });
      break;
    }

    await appendHarnessNote(
      layout.notesLogPath,
      `Attempt ${attempts} validation`,
      validation.passed
        ? validation.semanticValidation
          ? "Deterministic, Playwright gate, and semantic validation passed."
          : "Deterministic validation passed."
        : [
            formatFindingDelta(delta),
            ...validation.findings
              .filter(finding => finding.status !== "fixed")
              .map(finding => `- [${finding.category}] ${finding.message}`),
          ].join("\n"),
    );

    await checkpoint({ layout, commitAttempt, workspacePath, attempt: attempts, validation });

    if (validation.passed) break;

    if (attemptsThisCycle < maxAttempts) {
      latestPrompt = await promptStrategy.buildRepairPrompt(
        validation.findings.filter(finding => finding.status !== "fixed"),
        attempts + 1,
      );
    }
  }

  return finishRun({
    layout,
    spec,
    specPath,
    workspacePath,
    attempts,
    attemptsThisCycle,
    maxAttempts,
    isContinue,
    cycle,
    startedAt,
    validation,
    delta,
  });
}

export { findingIds, logPhase };
