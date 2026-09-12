import type { AgentTelemetry, AgentUsageTotals, RateLimitSnapshot } from "./types.js";

/**
 * Run-level agent spend.
 *
 * The harness spends real money on every attempt — a generator session, and on
 * the semantic tier an evaluator session too — and until now reported none of
 * it. These totals are a sum of what the CLIs report about themselves, never an
 * estimate: a CLI that reports no cost contributes to `agentRuns` but not to
 * `costedRuns`, so a partial total is visibly partial rather than quietly low.
 */
export function emptyUsageTotals(): AgentUsageTotals {
  return { agentRuns: 0, costedRuns: 0 };
}

export function accumulateUsage(
  totals: AgentUsageTotals,
  telemetry: AgentTelemetry | undefined,
): AgentUsageTotals {
  if (!telemetry) return totals;

  const next: AgentUsageTotals = { ...totals, agentRuns: totals.agentRuns + 1 };

  if (telemetry.costUsd !== undefined) {
    next.costUsd = (next.costUsd ?? 0) + telemetry.costUsd;
    next.costedRuns += 1;
  }

  next.inputTokens = addOptional(next.inputTokens, telemetry.inputTokens);
  next.outputTokens = addOptional(next.outputTokens, telemetry.outputTokens);
  next.cacheReadInputTokens = addOptional(
    next.cacheReadInputTokens,
    telemetry.cacheReadInputTokens,
  );
  next.cacheCreationInputTokens = addOptional(
    next.cacheCreationInputTokens,
    telemetry.cacheCreationInputTokens,
  );

  return next;
}

/**
 * One-line spend summary, or `undefined` when nothing was reported.
 *
 * Returning `undefined` rather than a zeroed line matters: the Cursor CLI may
 * report no cost at all, and printing `$0.00` for a two-hour run would be a lie.
 */
export function formatAgentUsage(totals: AgentUsageTotals | undefined): string | undefined {
  if (!totals || totals.agentRuns === 0) return undefined;

  const parts: string[] = [];

  if (totals.costUsd !== undefined) {
    const partial =
      totals.costedRuns < totals.agentRuns
        ? ` (${totals.costedRuns}/${totals.agentRuns} agent runs reported cost)`
        : ` (${totals.agentRuns} agent run${totals.agentRuns === 1 ? "" : "s"})`;
    parts.push(`$${totals.costUsd.toFixed(2)}${partial}`);
  } else {
    parts.push(`${totals.agentRuns} agent run${totals.agentRuns === 1 ? "" : "s"}, cost not reported`);
  }

  const tokens = [
    totals.inputTokens !== undefined ? `in ${formatCount(totals.inputTokens)}` : undefined,
    totals.outputTokens !== undefined ? `out ${formatCount(totals.outputTokens)}` : undefined,
    totals.cacheReadInputTokens !== undefined
      ? `cached ${formatCount(totals.cacheReadInputTokens)}`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  if (tokens.length > 0) {
    parts.push(`tokens ${tokens.join(" / ")}`);
  }

  return parts.join(" — ");
}

/**
 * Why the run should stop now rather than spend its remaining attempts.
 *
 * A rejected rate limit is infrastructure, not an app defect: re-prompting the
 * agent cannot succeed until the window resets, so each further attempt would
 * fail identically and be reported as if the generated code were at fault.
 */
export function rateLimitAbortReason(
  telemetry: AgentTelemetry | undefined,
): string | undefined {
  const rateLimit = telemetry?.rateLimit;
  if (rateLimit?.status !== "rejected") return undefined;

  return `agent rate limit rejected${formatWindow(rateLimit)} — further attempts cannot succeed until it resets`;
}

/**
 * Whether a rate limit should stop the loop, and why.
 *
 * Two things never abort for a rate limit. A passing attempt has nothing left
 * to abort — the work is delivered, and the limit only bars attempts that would
 * have followed; reporting an infrastructure abort there would contradict the
 * PASSED verdict printed a line earlier. And an evaluation infrastructure
 * failure already owns the abort, with a more specific reason than this one.
 */
export function rateLimitAbort(input: {
  passed: boolean;
  evaluationInfrastructureFailure: boolean;
  generatorTelemetry?: AgentTelemetry;
  evaluatorTelemetry?: AgentTelemetry;
}): string | undefined {
  if (input.passed || input.evaluationInfrastructureFailure) return undefined;

  return (
    rateLimitAbortReason(input.generatorTelemetry) ??
    rateLimitAbortReason(input.evaluatorTelemetry)
  );
}

function formatWindow(rateLimit: RateLimitSnapshot): string {
  const window = rateLimit.rateLimitType ? ` (${rateLimit.rateLimitType}` : "";
  if (!window) return "";

  const resets =
    typeof rateLimit.resetsAt === "number" && Number.isFinite(rateLimit.resetsAt)
      ? `, resets ${new Date(rateLimit.resetsAt * 1000).toISOString()}`
      : "";
  return `${window}${resets})`;
}

function addOptional(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
