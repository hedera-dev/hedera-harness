import type { ValidationFinding } from "./types.js";

/**
 * Per-attempt movement in the finding set.
 *
 * A raw pass/fail plus a count answers "did it work"; it does not answer "is the
 * repair loop converging". Comparing finding ids between attempts distinguishes
 * an agent closing issues from one trading them for new ones — which is the
 * signal for whether spending another attempt is worthwhile.
 */
export interface FindingDelta {
  /** Ids still failing after this attempt. */
  open: string[];
  /** Ids open before this attempt and no longer reported. */
  fixed: string[];
  /** Ids reported for the first time this attempt. */
  introduced: string[];
}

export function findingIds(findings: ValidationFinding[]): string[] {
  return [...new Set(findings.map(finding => finding.id))];
}

export function computeFindingDelta(
  previousOpenIds: string[],
  findings: ValidationFinding[],
): FindingDelta {
  const previous = new Set(previousOpenIds);
  const open = findingIds(findings);
  const current = new Set(open);

  return {
    open,
    fixed: previousOpenIds.filter(id => !current.has(id)),
    introduced: open.filter(id => !previous.has(id)),
  };
}

/**
 * Stamp findings with their lifecycle status, and re-surface previously open
 * findings that this attempt cleared so a report shows what improved rather than
 * only what is left.
 */
export function applyFindingStatus(
  findings: ValidationFinding[],
  delta: FindingDelta,
  previousFindings: ValidationFinding[] = [],
): ValidationFinding[] {
  const open: ValidationFinding[] = findings.map(finding => ({ ...finding, status: "open" }));

  const fixed = new Set(delta.fixed);
  const carried = previousFindings
    .filter(finding => fixed.has(finding.id))
    .map(finding => ({ ...finding, status: "fixed" as const }));

  // Deduplicate: a previously open finding can appear once per prior attempt.
  const seen = new Set<string>();
  const uniqueCarried = carried.filter(finding => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });

  return [...open, ...uniqueCarried];
}

/** One-line convergence summary for the console and run notes. */
export function formatFindingDelta(delta: FindingDelta): string {
  if (delta.open.length === 0 && delta.fixed.length === 0) {
    return "no findings";
  }
  const parts = [`${delta.open.length} open`];
  if (delta.fixed.length > 0) parts.push(`${delta.fixed.length} fixed`);
  if (delta.introduced.length > 0) parts.push(`${delta.introduced.length} new`);
  return parts.join(", ");
}
