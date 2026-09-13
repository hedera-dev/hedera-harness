import { formatUsd, type AgentUsage } from "./agentStreamLogger.js";

/**
 * What a run has spent on its coding agent so far, attempt by attempt.
 *
 * The harness already tells you whether another attempt is worth its 15–40
 * minutes ("2 open, 3 fixed"). This adds the other half of that decision: what
 * the attempts cost, and a ceiling that stops the loop before a repair that
 * fixes nothing turns into an invoice.
 *
 * Cost is only ever what the agent reported. When the agent CLI reports no
 * usage (Cursor does not), `totalUsd` stays undefined and the budget cannot be
 * enforced — the harness says so rather than pretending the run was free.
 */
export interface AttemptCost {
  attempt: number;
  usage: AgentUsage;
}

export interface RunCost {
  attempts: AttemptCost[];
  /** Sum of reported `costUsd` across attempts; undefined when nothing was reported. */
  totalUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Attempts whose agent reported no usage at all. */
  unknownAttempts: number;
  /** `budget.maxCostUsd` from the recipe, when set. */
  budgetUsd?: number;
  /** True when the loop stopped because `totalUsd` reached `budgetUsd`. */
  budgetExhausted: boolean;
}

export function createRunCost(budgetUsd?: number, seed?: RunCost): RunCost {
  if (seed) {
    return { ...seed, attempts: [...seed.attempts], budgetUsd: budgetUsd ?? seed.budgetUsd };
  }
  return { attempts: [], unknownAttempts: 0, budgetUsd, budgetExhausted: false };
}

export function recordAttemptCost(cost: RunCost, attempt: number, usage?: AgentUsage): RunCost {
  const reported: AgentUsage = usage ?? { reported: false };
  const next: RunCost = {
    ...cost,
    attempts: [...cost.attempts, { attempt, usage: reported }],
    unknownAttempts: cost.unknownAttempts + (reported.reported ? 0 : 1),
  };
  if (reported.costUsd !== undefined) {
    next.totalUsd = (cost.totalUsd ?? 0) + reported.costUsd;
  }
  if (reported.inputTokens !== undefined) {
    next.inputTokens = (cost.inputTokens ?? 0) + reported.inputTokens;
  }
  if (reported.outputTokens !== undefined) {
    next.outputTokens = (cost.outputTokens ?? 0) + reported.outputTokens;
  }
  return next;
}

/** The ceiling is reached once reported spend meets it. Unknown spend never trips it. */
export function isBudgetReached(cost: RunCost): boolean {
  return (
    cost.budgetUsd !== undefined && cost.totalUsd !== undefined && cost.totalUsd >= cost.budgetUsd
  );
}

/** `$1.42 this attempt, $4.10 so far (budget $5.00)` */
export function formatAttemptSpend(cost: RunCost, attempt: number): string {
  const entry = cost.attempts.find(item => item.attempt === attempt);
  const usage = entry?.usage;
  if (!usage?.reported) {
    return cost.budgetUsd !== undefined
      ? `cost unknown — the agent reported no usage, so budget ${formatUsd(cost.budgetUsd)} cannot be enforced`
      : "cost unknown";
  }
  const parts: string[] = [];
  if (usage.costUsd !== undefined) {
    parts.push(`${formatUsd(usage.costUsd)} this attempt`);
    if (cost.totalUsd !== undefined && cost.attempts.length > 1) {
      parts.push(`${formatUsd(cost.totalUsd)} so far`);
    }
  } else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(
      `${formatCount(usage.inputTokens)} in / ${formatCount(usage.outputTokens)} out tokens this attempt`,
    );
  }
  if (cost.budgetUsd !== undefined) {
    parts.push(`budget ${formatUsd(cost.budgetUsd)}`);
  }
  return parts.join(", ");
}

/** One-line total for the outro and the run notes. */
export function formatRunCost(cost: RunCost | undefined): string {
  if (!cost || cost.attempts.length === 0) return "unknown";
  if (cost.totalUsd === undefined) {
    return cost.inputTokens !== undefined || cost.outputTokens !== undefined
      ? `${formatCount(cost.inputTokens)} in / ${formatCount(cost.outputTokens)} out tokens (no price reported)`
      : "unknown (agent reported no usage)";
  }
  const partial = cost.unknownAttempts > 0 ? ` + ${cost.unknownAttempts} attempt(s) unreported` : "";
  const budget =
    cost.budgetUsd !== undefined
      ? cost.budgetExhausted
        ? ` — budget ${formatUsd(cost.budgetUsd)} exhausted`
        : ` (budget ${formatUsd(cost.budgetUsd)})`
      : "";
  return `${formatUsd(cost.totalUsd)}${partial}${budget}`;
}

function formatCount(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
