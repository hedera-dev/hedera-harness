import type { ValidationFinding } from "./types.js";

/** Per-attempt movement in the finding set (convergence, not just pass/fail). */
export interface FindingDelta {
  open: string[];
  fixed: string[];
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

/** Stamp status and re-surface findings this attempt closed so the report shows progress. */
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

  const seen = new Set<string>();
  const uniqueCarried = carried.filter(finding => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });

  return [...open, ...uniqueCarried];
}

export function formatFindingDelta(delta: FindingDelta): string {
  if (delta.open.length === 0 && delta.fixed.length === 0) {
    return "no findings";
  }
  const parts = [`${delta.open.length} open`];
  if (delta.fixed.length > 0) parts.push(`${delta.fixed.length} fixed`);
  if (delta.introduced.length > 0) parts.push(`${delta.introduced.length} new`);
  return parts.join(", ");
}
