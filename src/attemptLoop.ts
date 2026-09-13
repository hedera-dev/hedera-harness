import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { selectModel, withModel } from "./modelSelection.js";
import { AGENT_PRESETS } from "./specDefaults.js";
import { envAgentTimeoutMs } from "./env.js";
import {
  buildSessionContinuePrompt,
  buildSessionPrompt,
  buildSessionRepairPrompt,
} from "./promptBuilder.js";
import { appendHarnessLog, appendHarnessNote, type RunLayout } from "./runArtifacts.js";
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
import type { VendoredSkill } from "./skillProvider.js";
import type {
  ChainSigner,
  RunReport,
  TemplateSpec,
  ValidationFinding,
  ValidationResult,
} from "./types.js";
import type { CheckpointCommitResult } from "./harnessGit.js";
import {
  createRunCost,
  formatAttemptSpend,
  isBudgetReached,
  recordAttemptCost,
  type RunCost,
} from "./costTracking.js";
import { formatUsd } from "./agentStreamLogger.js";

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

/**
 * Position of the current increment in an ordered `prd:` list.
 *
 * Single-PRD recipes get `{ index: 0, count: 1 }`, which renders no slice
 * framing at all — so the common case reads exactly as it did before.
 */
export interface SliceContext {
  index: number;
  count: number;
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
  /** Which increment of an ordered `prd:` list this loop is delivering. */
  slice?: SliceContext;
  /** Finding ids still open when the previous cycle stopped, for delta reporting. */
  previousOpenFindingIds?: string[];
  /** Spend carried over from earlier increments of this kick, so one budget covers the run. */
  costSoFar?: RunCost;
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
  session: Pick<SessionContext, "spec" | "vendoredSkills" | "vendoredContext"> & {
    slice?: SliceContext;
  },
): AttemptPromptStrategy {
  const { spec, vendoredSkills, vendoredContext, slice } = session;
  return {
    async buildInitialPrompt(isContinue, cycle) {
      return isContinue
        ? buildSessionContinuePrompt(spec, cycle!, vendoredSkills, vendoredContext, slice)
        : buildSessionPrompt(spec, 1, vendoredSkills, vendoredContext, slice);
    },
    async buildRepairPrompt(findings, nextAttempt) {
      return buildSessionRepairPrompt(spec, findings, nextAttempt, vendoredContext);
    },
  };
}

/** In-place project-centric `run` attempt loop. */
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

  const promptStrategy = input.promptStrategy ?? createSessionPromptStrategy(input);
  const agentTimeoutMs = envAgentTimeoutMs();

  let attempts = input.startingAttempt - 1;
  let attemptsThisCycle = 0;
  let validation: ValidationResult = notRunYet();
  let latestPrompt = await promptStrategy.buildInitialPrompt(isContinue, cycle);
  let openFindingIds = input.previousOpenFindingIds ?? [];
  let previousFindings: ValidationFinding[] = [];
  let delta: FindingDelta = { open: openFindingIds, fixed: [], introduced: [] };
  let cost = createRunCost(spec.budget?.maxCostUsd, input.costSoFar);
  let warnedUnenforceableBudget = false;

  while (attemptsThisCycle < maxAttempts) {
    attempts += 1;
    attemptsThisCycle += 1;

    const context: AttemptStageContext = {
      attempt: attempts,
      spec,
      workspacePath,
      layout,
      chainSigner,
      evalRelativePath: vendoredContext.evalRelativePath,
    };

    const kind = attemptKind(isContinue, attempts, attemptsThisCycle);
    const choice = selectModel({
      spec,
      isFirstAttemptOfCycle: attemptsThisCycle === 1,
      previousFixedCount: delta.fixed.length,
      hasRepaired: attemptsThisCycle > 1,
    });
    await announceAttempt({
      layout,
      kind,
      attempt: attempts,
      cycle,
      attemptsThisCycle,
      prompt: latestPrompt,
      model: choice,
    });

    const generatorConfig = withModel(
      agentTimeoutMs ? { ...spec.generator, timeoutMs: agentTimeoutMs } : spec.generator,
      AGENT_PRESETS[spec.agent].modelFlag,
      choice.model,
    );

    const generate = await runGenerateStage(context, {
      generator: new CommandAgentProvider(generatorConfig),
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

    cost = recordAttemptCost(cost, attempts, generate.agentResult.usage);
    if (cost.budgetUsd !== undefined && !generate.agentResult.usage?.reported && !warnedUnenforceableBudget) {
      warnedUnenforceableBudget = true;
      logPhase(
        "Budget cannot be enforced",
        `budget.maxCostUsd is ${formatUsd(cost.budgetUsd)} but the agent reported no usage on its stream; attempts will not be stopped on spend`,
      );
    }

    validation = await runValidationStages(context, generate.finding);

    delta = computeFindingDelta(openFindingIds, validation.findings);
    validation.findings = applyFindingStatus(validation.findings, delta, previousFindings);
    previousFindings = validation.findings;
    openFindingIds = delta.open;

    await recordAttemptResult({
      layout,
      attempt: attempts,
      validation,
      delta,
      spend: formatAttemptSpend(cost, attempts),
      cost,
    });

    if (validation.evaluation?.infrastructureFailure) {
      await abortOnInfrastructureFailure({ layout, attempt: attempts, validation });
      await checkpoint({ layout, commitAttempt, workspacePath, attempt: attempts, validation });
      break;
    }

    await appendHarnessNote(
      layout.notesLogPath,
      `Attempt ${attempts} validation`,
        validation.passed
          ? validation.evaluation
            ? "Deterministic, Playwright gate, and evaluate checklist passed."
            : "Deterministic validation passed."
        : [
            formatFindingDelta(delta),
            ...validation.findings
              .filter(f => f.status !== "fixed")
              .map(f => `- [${f.category}] ${f.message}`),
          ].join("\n"),
    );

    await checkpoint({ layout, commitAttempt, workspacePath, attempt: attempts, validation });

    if (validation.passed) break;

    // A repair that fixes nothing costs as much as one that does. Once reported
    // spend reaches the ceiling, stop and leave the branch for a human — the
    // findings above are what the next kick would repair anyway.
    if (isBudgetReached(cost)) {
      cost = { ...cost, budgetExhausted: true };
      const attemptsUnused = maxAttempts - attemptsThisCycle;
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "budget_exhausted",
        timestamp: new Date().toISOString(),
        attempt: attempts,
        totalUsd: cost.totalUsd!,
        budgetUsd: cost.budgetUsd!,
        attemptsUnused,
      });
      await appendHarnessNote(
        layout.notesLogPath,
        `Attempt ${attempts} budget exhausted`,
        `Reported agent spend ${formatUsd(cost.totalUsd!)} reached budget.maxCostUsd ${formatUsd(cost.budgetUsd!)}; ${attemptsUnused} attempt(s) left unused.`,
      );
      logPhase(
        "Budget exhausted — stopping",
        `${formatUsd(cost.totalUsd!)} of ${formatUsd(cost.budgetUsd!)} spent after ${attemptsThisCycle} attempt(s); ${attemptsUnused} unused. Raise budget.maxCostUsd or continue the branch by hand.`,
      );
      break;
    }

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
    cost,
  });
}

export { findingIds, logPhase };
