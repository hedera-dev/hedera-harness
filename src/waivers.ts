import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { FindingWaiver, ValidationFinding, ValidationResult } from "./types.js";

/**
 * Accepted findings.
 *
 * A gate sometimes reports something a human has looked at and accepted for
 * now: a console warning from a vendor script, a lint rule the team disagrees
 * with, a route the PRD explicitly leaves for later. Without a place to say
 * so, every attempt of every run pays an agent to "repair" it, and the only
 * escape is to weaken the validator for everyone.
 *
 * `.harness/waivers.yaml` records such decisions: which finding, why, who, and
 * until when. A matching finding is still reported, marked `waived`, but it
 * does not fail the stage and is never sent to the agent. Every waiver must
 * expire, so an accepted finding cannot quietly become a permanent hole, and
 * secret findings can never be waived at all.
 */

/** Categories a waiver never applies to, whatever the file says. */
export const NON_WAIVABLE_CATEGORIES: ReadonlySet<ValidationFinding["category"]> = new Set<
  ValidationFinding["category"]
>(["secret", "agent", "eval-infra"]);

const WAIVER_KEYS = new Set(["finding", "reason", "expires", "by"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function loadWaivers(waiversPath: string): Promise<FindingWaiver[]> {
  const raw = await readFile(waiversPath, "utf8");
  const parsed = parseYaml(raw) ?? {};
  return parseWaivers(parsed, waiversPath);
}

/** Pure parser, separated from the file read so malformed input is testable in isolation. */
export function parseWaivers(parsed: unknown, source = "waivers.yaml"): FindingWaiver[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a mapping with a "waivers" list.`);
  }
  const list = (parsed as Record<string, unknown>).waivers;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error(`${source}: "waivers" must be a list.`);
  }

  return list.map((entry, index) => parseWaiver(entry, `${source}: waivers[${index}]`));
}

function parseWaiver(entry: unknown, where: string): FindingWaiver {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${where} must be a mapping with finding, reason and expires.`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!WAIVER_KEYS.has(key)) {
      throw new Error(`${where}: unknown key "${key}". Allowed: finding, reason, expires, by.`);
    }
  }

  const finding = readNonEmpty(record.finding, `${where}.finding`);
  assertWaivablePattern(finding, where);
  const reason = readNonEmpty(record.reason, `${where}.reason`);

  const expires = record.expires instanceof Date ? record.expires.toISOString().slice(0, 10) : record.expires;
  if (typeof expires !== "string" || !DATE_PATTERN.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
    throw new Error(
      `${where}.expires must be a date (YYYY-MM-DD). A waiver without an end date is a gate that was silently removed.`,
    );
  }

  const by = record.by === undefined ? undefined : readNonEmpty(record.by, `${where}.by`);
  return { finding, reason, expires, ...(by ? { by } : {}) };
}

function readNonEmpty(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${where} must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * A pattern may end in `*` (one waiver for every route of a gate, say) but
 * must name what it waives: no leading wildcard, no bare `*`, and nothing
 * that could reach a secret finding.
 */
function assertWaivablePattern(pattern: string, where: string): void {
  const literalPrefix = pattern.split("*")[0] ?? "";
  if (!literalPrefix) {
    throw new Error(
      `${where}.finding "${pattern}" must start with the finding id it accepts; a leading wildcard would waive every gate.`,
    );
  }
  if (/^secret/i.test(literalPrefix)) {
    throw new Error(`${where}.finding "${pattern}": secret findings cannot be waived.`);
  }
}

/**
 * `*` matches any run of characters; everything else is literal. Written as a
 * two-cursor walk rather than a RegExp: the pattern comes from a file in the
 * project, and a regular expression built from it could be made to backtrack
 * for a long time on a crafted id.
 */
export function waiverMatches(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;

  let p = 0;
  let i = 0;
  let starAt = -1;
  let resumeAt = 0;
  while (i < id.length) {
    if (p < pattern.length && pattern[p] === "*") {
      starAt = p;
      resumeAt = i;
      p += 1;
    } else if (p < pattern.length && pattern[p] === id[i]) {
      p += 1;
      i += 1;
    } else if (starAt >= 0) {
      p = starAt + 1;
      resumeAt += 1;
      i = resumeAt;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** Waivers whose end date is before today (a waiver is valid through its `expires` day). */
export function expiredWaivers(waivers: FindingWaiver[], now: Date = new Date()): FindingWaiver[] {
  const today = now.toISOString().slice(0, 10);
  return waivers.filter(waiver => waiver.expires < today);
}

export interface AppliedWaivers {
  findings: ValidationFinding[];
  /** Ids the active waivers accepted this time. */
  waivedIds: string[];
  /** Findings a waiver matched but whose category can never be waived. */
  refused: ValidationFinding[];
}

/**
 * Mark matching findings `waived`. Fixed findings and non-waivable categories
 * are left alone; expired waivers do not match anything.
 */
export function applyWaivers(
  findings: ValidationFinding[],
  waivers: FindingWaiver[],
  now: Date = new Date(),
): AppliedWaivers {
  if (waivers.length === 0) return { findings, waivedIds: [], refused: [] };

  const expired = new Set(expiredWaivers(waivers, now));
  const active = waivers.filter(waiver => !expired.has(waiver));
  const waivedIds: string[] = [];
  const refused: ValidationFinding[] = [];

  const result = findings.map(finding => {
    if (finding.status === "fixed") return finding;
    const waiver = active.find(candidate => waiverMatches(candidate.finding, finding.id));
    if (!waiver) return finding;
    if (NON_WAIVABLE_CATEGORIES.has(finding.category)) {
      refused.push(finding);
      return finding;
    }
    if (!waivedIds.includes(finding.id)) waivedIds.push(finding.id);
    return { ...finding, status: "waived" as const, waiver };
  });

  return { findings: result, waivedIds, refused };
}

/** True when a finding still counts against the stage it came from. */
export function isBlockingFinding(finding: ValidationFinding): boolean {
  return finding.category !== "agent" && finding.status !== "waived" && finding.status !== "fixed";
}

/**
 * Apply waivers to a stage result and recompute `passed` from what is left.
 * A result that could not run its gates stays failed whatever is waived.
 */
export function waiveValidation(
  result: ValidationResult,
  waivers: FindingWaiver[],
  now: Date = new Date(),
): ValidationResult {
  if (waivers.length === 0) return result;
  const applied = applyWaivers(result.findings, waivers, now);
  for (const finding of applied.refused) {
    console.log(
      `[hedera-harness] Waiver ignored for ${finding.id} — [${finding.category}] findings cannot be waived`,
    );
  }
  return {
    ...result,
    findings: applied.findings,
    passed: applied.findings.every(finding => !isBlockingFinding(finding)),
  };
}

export function describeWaiver(finding: ValidationFinding): string {
  const waiver = finding.waiver;
  if (!waiver) return "";
  return `${waiver.reason} (${waiver.by ? `${waiver.by}, ` : ""}until ${waiver.expires})`;
}
