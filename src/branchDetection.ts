/** Primary branch prefix for project-centric `run`. New branches always use this. */
export const HARNESS_RUN_BRANCH_PREFIX = "harness/run-";

export function slugifyForBranch(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "feature";
}

export type HarnessBranchAction = "continue" | "new";

export interface ParsedHarnessBranch {
  prefix: typeof HARNESS_RUN_BRANCH_PREFIX;
  /** Spec slug embedded in the branch name (between prefix and trailing short id). */
  specSlug: string;
  shortId: string;
  branch: string;
}

export interface BranchDecisionInput {
  currentBranch: string | null | undefined;
  /** Spec `name` field (slugified for comparison). */
  specName: string;
  /** Force a fresh harness branch even when current branch matches the spec. */
  forceNew?: boolean;
  /**
   * Explicit branch to continue on. When set, caller is expected to checkout
   * this branch before session prepare; decision is always `continue`.
   */
  continueBranch?: string;
}

export interface BranchDecision {
  action: HarnessBranchAction;
  reason: string;
  parsedCurrent?: ParsedHarnessBranch;
}

/** True when `branch` is a harness session branch (`harness/run-*`). */
export function isHarnessBranch(branch: string | null | undefined): boolean {
  return Boolean(branch && branch.startsWith(HARNESS_RUN_BRANCH_PREFIX));
}

/**
 * Parse `harness/run-<slug>-<id>`.
 * Returns null when the branch is not a harness branch or lacks a trailing id segment.
 */
export function parseHarnessBranch(branch: string | null | undefined): ParsedHarnessBranch | null {
  if (!branch?.startsWith(HARNESS_RUN_BRANCH_PREFIX)) return null;

  const rest = branch.slice(HARNESS_RUN_BRANCH_PREFIX.length);
  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0 || lastDash === rest.length - 1) {
    return null;
  }

  const shortId = rest.slice(lastDash + 1);
  const specSlug = rest.slice(0, lastDash);
  if (!specSlug || !/^[a-f0-9]+$/i.test(shortId)) {
    return null;
  }

  return { prefix: HARNESS_RUN_BRANCH_PREFIX, specSlug, shortId, branch };
}

export function specSlugMatchesBranch(specName: string, branch: string | null | undefined): boolean {
  const parsed = parseHarnessBranch(branch);
  if (!parsed) return false;
  return parsed.specSlug === slugifyForBranch(specName);
}

/**
 * Decide whether to continue on the current harness branch or create a new one.
 *
 * Rules:
 * - `--continue <branch>` → continue
 * - `--new` → new
 * - On harness branch + same spec slug → continue
 * - On harness branch + different spec slug → new
 * - On normal branch → new
 */
export function decideBranchAction(input: BranchDecisionInput): BranchDecision {
  if (input.continueBranch?.trim()) {
    return {
      action: "continue",
      reason: `explicit --continue ${JSON.stringify(input.continueBranch.trim())}`,
    };
  }

  if (input.forceNew) {
    return { action: "new", reason: "explicit --new" };
  }

  const parsed = parseHarnessBranch(input.currentBranch);
  if (!parsed) {
    return {
      action: "new",
      reason: input.currentBranch
        ? `current branch ${JSON.stringify(input.currentBranch)} is not a harness branch`
        : "no current branch",
    };
  }

  const expectedSlug = slugifyForBranch(input.specName);
  if (parsed.specSlug === expectedSlug) {
    return {
      action: "continue",
      reason: `current harness branch matches spec slug ${JSON.stringify(expectedSlug)}`,
      parsedCurrent: parsed,
    };
  }

  return {
    action: "new",
    reason: `current harness branch slug ${JSON.stringify(parsed.specSlug)} differs from spec ${JSON.stringify(expectedSlug)}`,
    parsedCurrent: parsed,
  };
}

export function buildRunBranchName(specSlug: string, shortId: string): string {
  return `${HARNESS_RUN_BRANCH_PREFIX}${slugifyForBranch(specSlug)}-${shortId}`;
}
