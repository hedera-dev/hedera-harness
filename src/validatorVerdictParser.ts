import type { ValidatorIssue, ValidatorVerdict } from "./types.js";

export function parseValidatorVerdict(agentStdout: string): ValidatorVerdict | null {
  const candidates: string[] = [];

  for (const line of agentStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (event.type === "result" && typeof event.result === "string") {
        candidates.push(event.result);
      }
    } catch {
      // not stream-json
    }
  }

  candidates.push(agentStdout);
  candidates.push(...extractFencedJsonBlocks(agentStdout));

  for (const candidate of candidates) {
    const verdict = tryParseVerdict(candidate);
    if (verdict) return verdict;
  }

  return null;
}

function extractFencedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    blocks.push(match[1].trim());
    match = pattern.exec(text);
  }
  return blocks;
}

function tryParseVerdict(text: string): ValidatorVerdict | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return tryParseObject(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return null;
}

function tryParseObject(text: string): ValidatorVerdict | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.passed !== "boolean" || typeof parsed.summary !== "string") {
      return null;
    }

    const issues = Array.isArray(parsed.issues)
      ? parsed.issues
          .map(issue => normalizeIssue(issue))
          .filter((issue): issue is NonNullable<typeof issue> => issue !== null)
      : [];

    return {
      passed: parsed.passed,
      summary: parsed.summary,
      issues,
    };
  } catch {
    return null;
  }
}

function normalizeIssue(value: unknown): ValidatorIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const issue = value as Record<string, unknown>;
  if (typeof issue.id !== "string" || typeof issue.message !== "string") {
    return null;
  }

  const severity = issue.severity;
  if (severity !== "critical" && severity !== "major" && severity !== "minor") {
    return null;
  }

  return {
    id: issue.id,
    assertion: typeof issue.assertion === "string" ? issue.assertion : undefined,
    severity,
    route: typeof issue.route === "string" ? issue.route : undefined,
    message: issue.message,
    evidence: typeof issue.evidence === "string" ? issue.evidence : undefined,
  };
}
