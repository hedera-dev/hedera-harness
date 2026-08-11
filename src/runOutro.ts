import type { CleanupResult } from "./runCleanup.js";
import type { SessionMetadata } from "./session.js";
import type { RunReport } from "./types.js";

export interface OutroInput {
  report: RunReport;
  session: SessionMetadata;
  cleanup: CleanupResult;
  specPath: string;
}

/**
 * Human-readable success/failure outro. Never implies the harness pushed,
 * opened a PR, merged, deleted a branch, or switched away from the harness branch.
 */
export function formatRunOutro(input: OutroInput): string[] {
  const { report, session, cleanup, specPath } = input;
  const infraAbort = Boolean(report.semanticValidation?.infrastructureFailure);
  const status = report.passed ? "PASSED" : infraAbort ? "ABORTED" : "FAILED";

  const lines: string[] = [
    `Run ${status}`,
    `branch=${session.branch}`,
    `base=${session.baseBranch} @ ${session.baseSha.slice(0, 8)}`,
    `workspace=${report.workspacePath}`,
    `report=${report.runDirectory}/reports/report.json`,
    `session=${report.runDirectory}/session.json`,
    `attempts=${report.attemptsThisCycle ?? report.attempts}/${report.maxAttempts}`,
    report.cycle ? `cycle=${report.cycle}` : undefined,
    `findings=${report.validation.findings.length}`,
    cleanup.removedPaths.length > 0
      ? `cleaned=${cleanup.removedPaths.join(", ")}`
      : "cleaned=(nothing removable left)",
    cleanup.mcpStripped ? "mcp=stripped harness playwright injection" : "mcp=unchanged",
    cleanup.treeClean
      ? "workingTree=clean (consumer-relevant)"
      : `workingTree=dirty (${cleanup.consumerDirtyPaths.length} path(s))`,
    "",
    "The harness did not push, open a PR, merge, delete a branch, or switch branches.",
  ].filter((line): line is string => line !== undefined);

  if (!cleanup.treeClean) {
    lines.push(
      "Remaining consumer-relevant dirty paths (not auto-committed):",
      ...cleanup.consumerDirtyPaths.slice(0, 12).map(filePath => `  - ${filePath}`),
    );
    if (cleanup.consumerDirtyPaths.length > 12) {
      lines.push(`  …and ${cleanup.consumerDirtyPaths.length - 12} more`);
    }
    lines.push("");
  }

  if (report.passed) {
    lines.push(
      "Optional next steps (run manually):",
      `  git push -u origin ${session.branch}`,
      `  gh pr create --base ${session.baseBranch}`,
      "",
      "Optional before merge: squash harness attempt commits.",
    );
  } else {
    lines.push(
      "You remain on the harness run branch with persisted reports.",
      "",
      "Continue (same branch, automatic session match):",
      `  hedera-harness run ${specPath}`,
      "",
      "Start a fresh branch for the same spec:",
      `  hedera-harness run ${specPath} --new`,
      "",
      "Inspect:",
      `  cat ${report.runDirectory}/reports/report.json`,
      "  git log --oneline",
      "",
      "Abandon (manual; not run by the harness):",
      `  git checkout ${session.baseBranch}`,
      `  git branch -D ${session.branch}`,
    );
  }

  if (!report.passed && report.validation.findings.length > 0) {
    lines.push("", "Findings:");
    lines.push(
      ...report.validation.findings
        .slice(0, 20)
        .map(finding => `- [${finding.category}] ${finding.id}: ${finding.message}`),
    );
  }

  return lines;
}
