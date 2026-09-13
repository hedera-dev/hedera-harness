import type { ValidationFinding } from "./types.js";

/** Per-attempt movement in the finding set (convergence, not just pass/fail). */
export interface FindingDelta {
  open: string[];
  fixed: string[];
  introduced: string[];
  /** Ids a waiver accepted this attempt. Not open, not fixed: a human's call, not the agent's. */
  waived: string[];
}

export function findingIds(findings: ValidationFinding[]): string[] {
  return [...new Set(findings.map(finding => finding.id))];
}

export function computeFindingDelta(
  previousOpenIds: string[],
  findings: ValidationFinding[],
): FindingDelta {
  const previous = new Set(previousOpenIds);
  const waived = findingIds(findings.filter(finding => finding.status === "waived"));
  const waivedSet = new Set(waived);
  const open = findingIds(findings).filter(id => !waivedSet.has(id));
  const current = new Set(open);

  return {
    open,
    // A finding that was open last attempt and is waived now is not "fixed":
    // nothing in the app changed, a person accepted it.
    fixed: previousOpenIds.filter(id => !current.has(id) && !waivedSet.has(id)),
    introduced: open.filter(id => !previous.has(id)),
    waived,
  };
}

/** Stamp status and re-surface findings this attempt closed so the report shows progress. */
export function applyFindingStatus(
  findings: ValidationFinding[],
  delta: FindingDelta,
  previousFindings: ValidationFinding[] = [],
): ValidationFinding[] {
  const open: ValidationFinding[] = findings.map(finding => ({
    ...finding,
    status: finding.status === "waived" ? "waived" : "open",
  }));

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
  // Deltas read back from reports written before waivers existed have no `waived`.
  const waived = delta.waived ?? [];
  if (delta.open.length === 0 && delta.fixed.length === 0) {
    return waived.length > 0 ? `no findings, ${waived.length} waived` : "no findings";
  }
  const parts = [`${delta.open.length} open`];
  if (delta.fixed.length > 0) parts.push(`${delta.fixed.length} fixed`);
  if (delta.introduced.length > 0) parts.push(`${delta.introduced.length} new`);
  if (waived.length > 0) parts.push(`${waived.length} waived`);
  return parts.join(", ");
}
