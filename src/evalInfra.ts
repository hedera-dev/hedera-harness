import type { EvaluationResult, ValidationFinding } from "./types.js";

const INFRA_FINDING_ID_PREFIXES = [
  "validator-config",
  "validator-runtime",
  "validator-exit:",
  "validator-output-unparseable",
  "validator-empty-issues",
] as const;

const INFRA_TEXT_PATTERNS: RegExp[] = [
  /user rejected mcp/i,
  /playwright mcp(?: browser tools)? (?:were |was )?(?:rejected|unavailable)/i,
  /mcp(?: tool)?s? (?:were |was )?(?:rejected|unavailable)/i,
  /no playwright mcp/i,
  /playwright\/?mcp.*(unavailable|rejected)/i,
  /browser[_ ]navigate was rejected/i,
  // A missing browser build is the single most common EVALUATE infrastructure
  // failure, and none of the phrasings above matched its actual error text —
  // so it was reported as app defects and burned repair attempts.
  /browser .{0,40}is not installed/i,
  /browser[- _]unavailable/i,
  /executable doesn't exist/i,
  /expected executable at/i,
  /install-browser/i,
  /chrome-for-testing/i,
  /failed to launch/i,
  /no browser session could be started/i,
  /browser automation (?:was )?(?:unavailable|could not|failed)/i,
  /could not drive .{0,80} in a browser/i,
  /without browser access/i,
  /no browser access available/i,
  /no[- ]live[- ]browser/i,
  /evaluator-no-browser/i,
  /shell commands to run browser automation were rejected/i,
  /webfetch cannot reach localhost/i,
  // Chain / mirror-node infrastructure (not app defects)
  /mirror[_ ]?node (?:unreachable|unavailable|timeout|timed out|failed)/i,
  /testnet(?:\/relay)? (?:unreachable|unavailable|timeout|timed out)/i,
  // Require an outage signal — bare "hashio" matches normal RPC error text from app txs.
  /(?:hashio|json-?rpc(?: relay)?) .{0,60}(?:unreachable|unavailable|timeout|timed out|ECONNREFUSED)/i,
  /insufficient[_ ]payer[_ ]balance/i,
  /INSUFFICIENT_PAYER_BALANCE/,
  /test signer account not found/i,
  /chain signer (?:unavailable|failed|missing)/i,
  /hedera testnet (?:unreachable|unavailable)/i,
];

/**
 * Returns a short reason when evaluation failed due to harness / agent
 * tooling (MCP, browser, validator process) rather than the generated app.
 */
export function detectEvalInfrastructureFailure(
  result: EvaluationResult,
): string | undefined {
  if (result.passed) {
    return undefined;
  }

  for (const finding of result.findings) {
    if (isExplicitInfraFindingId(finding.id)) {
      return summarizeExplicitInfraFinding(finding);
    }
  }

  const corpus = buildFailureCorpus(result);
  if (!corpus.trim()) {
    return undefined;
  }

  if (/user rejected mcp/i.test(corpus) || /browser[_ ]navigate was rejected/i.test(corpus)) {
    return "Playwright MCP tool calls were rejected (need --force / --approve-mcps for headless validator).";
  }

  if (/playwright mcp(?: browser tools)? (?:were |was )?(?:rejected|unavailable)/i.test(corpus)) {
    return "Playwright MCP was unavailable or rejected; validator could not drive the live app.";
  }

  if (!looksLikeBrowserAccessBlocked(result, corpus)) {
    return undefined;
  }

  const matched = INFRA_TEXT_PATTERNS.find(pattern => pattern.test(corpus));
  if (!matched) {
    return undefined;
  }

  return (
    result.verdict?.summary?.trim() ||
    "Evaluator could not access a browser / Playwright MCP (infrastructure), not an app defect."
  );
}

export function annotateInfrastructureFailure(
  result: EvaluationResult,
): EvaluationResult {
  const reason = detectEvalInfrastructureFailure(result);
  if (!reason) {
    return result;
  }

  return {
    ...result,
    infrastructureFailure: true,
    infrastructureFailureReason: truncate(reason, 400),
    findings: result.findings.map(finding =>
      finding.category === "eval"
        ? {
            ...finding,
            category: "eval-infra",
          }
        : finding,
    ),
  };
}

function isExplicitInfraFindingId(id: string): boolean {
  return INFRA_FINDING_ID_PREFIXES.some(prefix =>
    prefix.endsWith(":") ? id.startsWith(prefix) : id === prefix,
  );
}

function summarizeExplicitInfraFinding(finding: ValidationFinding): string {
  return truncate(finding.message || finding.id, 400);
}

function buildFailureCorpus(result: EvaluationResult): string {
  return [
    result.verdict?.summary ?? "",
    ...result.findings.map(finding => `${finding.id}\n${finding.message}\n${finding.details ?? ""}`),
    ...(result.verdict?.issues ?? []).map(
      issue => `${issue.id}\n${issue.message}\n${issue.evidence ?? ""}`,
    ),
  ].join("\n");
}

function looksLikeBrowserAccessBlocked(result: EvaluationResult, corpus: string): boolean {
  const issues = result.verdict?.issues ?? [];
  if (issues.length >= 3) {
    const blocked = issues.filter(issue =>
      /browser|mcp|playwright|no-live-browser|evaluator-no-browser|unverified|no browser/i.test(
        `${issue.id} ${issue.message} ${issue.evidence ?? ""}`,
      ),
    );
    if (blocked.length / issues.length >= 0.8) {
      return true;
    }
  }

  const evalFindings = result.findings.filter(finding => finding.category === "eval");
  if (evalFindings.length >= 3) {
    const blocked = evalFindings.filter(finding =>
      /browser|mcp|playwright|without browser/i.test(`${finding.message} ${finding.details ?? ""}`),
    );
    if (blocked.length / evalFindings.length >= 0.8) {
      return true;
    }
  }

  return INFRA_TEXT_PATTERNS.some(pattern => pattern.test(corpus));
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
