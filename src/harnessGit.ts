import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  HARNESS_EXTEND_BRANCH_PREFIX,
  HARNESS_RUN_BRANCH_PREFIX,
  buildRunBranchName,
  isHarnessBranch,
  slugifyForBranch,
} from "./branchDetection.js";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import type { ValidationFinding } from "./types.js";

export {
  HARNESS_EXTEND_BRANCH_PREFIX,
  HARNESS_RUN_BRANCH_PREFIX,
  buildRunBranchName,
  isHarnessBranch,
  slugifyForBranch,
};

/** Paths that must never be committed / must not block clean continue. */
export const HARNESS_RUNTIME_PATH_PREFIXES = [
  ".harness/runs/",
  ".harness/cache/",
  ".harness/runtime/",
  ".harness-skills/",
  ".harness-context/",
  ".skill-cache/",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  "playwright-report/",
  "test-results/",
] as const;

export const HARNESS_RUNTIME_PATH_NAMES = new Set([
  ".harness/runs",
  ".harness/cache",
  ".harness/runtime",
  ".harness-skills",
  ".harness-context",
  ".skill-cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "playwright-report",
  "test-results",
  "chain-signer.json",
]);

/** Secret / credential paths that must never be staged by harness checkpoints. */
export const HARNESS_SECRET_PATH_MARKERS = [
  /^\.env(\.|$)/i,
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)secrets?\//i,
  /(^|\/)chain-signer\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)service-account.*\.json$/i,
  /(^|\/)\.cursor\/mcp\.json$/i,
] as const;

export interface GitWorkingTreeEntry {
  /** Porcelain XY status codes (e.g. " M", "??"). */
  code: string;
  path: string;
  origPath?: string;
}

export interface GitRepoSnapshot {
  repositoryRoot: string;
  branch: string | null;
  headSha: string;
  detached: boolean;
  inProgressOperation: string | null;
  entries: GitWorkingTreeEntry[];
}

export function isHarnessRuntimePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (HARNESS_RUNTIME_PATH_NAMES.has(normalized)) {
    return true;
  }
  return HARNESS_RUNTIME_PATH_PREFIXES.some(
    prefix => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

export function isHarnessSecretPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return HARNESS_SECRET_PATH_MARKERS.some(pattern => pattern.test(normalized));
}

export function filterRelevantDirtyEntries(entries: GitWorkingTreeEntry[]): GitWorkingTreeEntry[] {
  return entries.filter(entry => {
    if (isHarnessRuntimePath(entry.path)) return false;
    if (entry.origPath && isHarnessRuntimePath(entry.origPath)) return false;
    // Ignore harness-injected MCP churn for cleanliness / continue decisions.
    if (entry.path === ".cursor/mcp.json" || entry.path.endsWith("/.cursor/mcp.json")) {
      return false;
    }
    return true;
  });
}

/** Paths safe to stage for a harness checkpoint (excludes runtime + secrets). */
export function filterCommitableHarnessEntries(
  entries: GitWorkingTreeEntry[],
): { commitable: GitWorkingTreeEntry[]; skippedSecrets: GitWorkingTreeEntry[] } {
  const relevant = filterRelevantDirtyEntries(entries);
  const commitable: GitWorkingTreeEntry[] = [];
  const skippedSecrets: GitWorkingTreeEntry[] = [];
  for (const entry of relevant) {
    if (isHarnessSecretPath(entry.path) || (entry.origPath && isHarnessSecretPath(entry.origPath))) {
      skippedSecrets.push(entry);
      continue;
    }
    commitable.push(entry);
  }
  return { commitable, skippedSecrets };
}

export function formatAttemptCommitMessage(input: {
  attempt: number;
  passed: boolean;
  findings: ValidationFinding[];
}): { subject: string; body: string } {
  const subject = `harness: run attempt ${input.attempt} ${input.passed ? "passed" : "failed"}`;
  const findingIds = input.findings
    .map(finding => finding.id)
    .filter(Boolean)
    .slice(0, 30);
  const bodyLines = [
    `${input.findings.length} finding(s).`,
    findingIds.length > 0 ? `Finding IDs: ${findingIds.join(", ")}` : undefined,
    input.findings.length > 30 ? `…and ${input.findings.length - 30} more` : undefined,
    "",
    "Created by hedera-harness run. Optional: squash attempt commits before merge.",
  ].filter((line): line is string => line !== undefined);
  return { subject, body: bodyLines.join("\n") };
}

export async function resolveGitRepositoryRoot(cwd: string): Promise<string> {
  const result = await executeCommand({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  return path.resolve(result.stdout.trim());
}

export async function readGitRepoSnapshot(cwd: string): Promise<GitRepoSnapshot> {
  const repositoryRoot = await resolveGitRepositoryRoot(cwd);
  const headSha = await resolveHeadSha(repositoryRoot);
  const branch = await resolveCurrentBranch(repositoryRoot);
  const detached = await isDetachedHead(repositoryRoot);
  const inProgressOperation = await detectInProgressGitOperation(repositoryRoot);
  const entries = await readWorkingTreeEntries(repositoryRoot);
  return {
    repositoryRoot,
    branch,
    headSha,
    detached,
    inProgressOperation,
    entries,
  };
}

export async function resolveHeadSha(cwd: string): Promise<string> {
  const result = await executeCommandOrThrow({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd,
  });
  return result.stdout.trim();
}

export async function resolveCurrentBranch(cwd: string): Promise<string | null> {
  const result = await executeCommand({
    command: "git",
    args: ["branch", "--show-current"],
    cwd,
  });
  if (result.exitCode !== 0) {
    return null;
  }
  const branch = result.stdout.trim();
  return branch || null;
}

export async function isDetachedHead(cwd: string): Promise<boolean> {
  const result = await executeCommand({
    command: "git",
    args: ["symbolic-ref", "-q", "HEAD"],
    cwd,
  });
  return result.exitCode !== 0;
}

export async function detectInProgressGitOperation(cwd: string): Promise<string | null> {
  const gitDirResult = await executeCommand({
    command: "git",
    args: ["rev-parse", "--git-dir"],
    cwd,
  });
  if (gitDirResult.exitCode !== 0) {
    return null;
  }

  const gitDir = path.resolve(cwd, gitDirResult.stdout.trim());
  const markers: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["REBASE_HEAD", "rebase"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];

  for (const [marker, label] of markers) {
    try {
      await access(path.join(gitDir, marker));
      return label;
    } catch {
      // absent
    }
  }
  return null;
}

export async function readWorkingTreeEntries(cwd: string): Promise<GitWorkingTreeEntry[]> {
  const result = await executeCommandOrThrow({
    command: "git",
    args: ["status", "--porcelain=v1", "-uall"],
    cwd,
  });

  const entries: GitWorkingTreeEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) {
      const [from, to] = rest.split(" -> ");
      if (from && to) {
        entries.push({ code, path: to, origPath: from });
        continue;
      }
    }
    entries.push({ code, path: rest });
  }
  return entries;
}

export async function assertWorkingTreeCleanForRunStart(cwd: string): Promise<void> {
  const entries = filterRelevantDirtyEntries(await readWorkingTreeEntries(cwd));
  if (entries.length === 0) return;

  const preview = entries
    .slice(0, 12)
    .map(entry => `${entry.code} ${entry.path}`)
    .join("\n");
  const more = entries.length > 12 ? `\n...and ${entries.length - 12} more` : "";
  throw new Error(
    [
      "Harness run requires a completely clean working tree (no auto-stash).",
      "Commit or discard local changes, then re-run.",
      preview + more,
    ].join("\n"),
  );
}

/**
 * Create and checkout `harness/run-<slug>-<short-id>` from the current HEAD.
 * Caller must already have a clean working tree on an attached branch.
 */
export async function createAndCheckoutHarnessBranch(
  cwd: string,
  specSlug: string,
  shortId?: string,
): Promise<{ branch: string; headSha: string }> {
  const branch = buildRunBranchName(specSlug, shortId ?? randomBytes(3).toString("hex"));
  await executeCommandOrThrow({
    command: "git",
    args: ["checkout", "-b", branch],
    cwd,
  });
  const headSha = await resolveHeadSha(cwd);
  return { branch, headSha };
}

export interface CheckpointCommitResult {
  committed: boolean;
  commitSha?: string;
  message: string;
  skippedSecrets: string[];
}

/**
 * Commit consumer-relevant changes for a harness run attempt.
 * Uses the consumer repo's normal Git identity/hooks.
 * Never stages runtime/cache/vendor/secrets/MCP paths; never `git add -A`.
 */
export async function commitAttempt(
  workspacePath: string,
  attempt: number,
  passed: boolean,
  findings: ValidationFinding[] | number = [],
): Promise<CheckpointCommitResult> {
  const findingList: ValidationFinding[] = Array.isArray(findings)
    ? findings
    : Array.from({ length: findings }, (_, index) => ({
        id: `finding-${index + 1}`,
        category: "agent" as const,
        message: `finding ${index + 1}`,
      }));

  const { subject, body } = formatAttemptCommitMessage({
    attempt,
    passed,
    findings: findingList,
  });
  const { commitable, skippedSecrets } = filterCommitableHarnessEntries(
    await readWorkingTreeEntries(workspacePath),
  );

  if (commitable.length === 0) {
    return {
      committed: false,
      message: subject,
      skippedSecrets: skippedSecrets.map(entry => entry.path),
    };
  }

  // Safety: refuse path traversal / absolute paths in porcelain output.
  for (const entry of commitable) {
    if (path.isAbsolute(entry.path) || entry.path.includes("\0") || entry.path.startsWith("..")) {
      throw new Error(`Harness checkpoint refused unsafe path: ${JSON.stringify(entry.path)}`);
    }
  }

  const paths = commitable.map(entry => entry.path);
  // Stage explicitly — never `git add -A`.
  await executeCommandOrThrow({
    command: "git",
    args: ["add", "--", ...paths],
    cwd: workspacePath,
  });

  // Double-check the index does not contain secrets/runtime before commit.
  await assertIndexSafeForHarnessCommit(workspacePath);

  await executeCommandOrThrow({
    command: "git",
    args: ["commit", "-m", subject, "-m", body],
    cwd: workspacePath,
  });

  return {
    committed: true,
    commitSha: await resolveHeadSha(workspacePath),
    message: subject,
    skippedSecrets: skippedSecrets.map(entry => entry.path),
  };
}

async function assertIndexSafeForHarnessCommit(cwd: string): Promise<void> {
  const result = await executeCommandOrThrow({
    command: "git",
    args: ["diff", "--cached", "--name-only", "-z"],
    cwd,
  });
  const staged = result.stdout.split("\0").map(value => value.trim()).filter(Boolean);
  const unsafe = staged.filter(
    filePath => isHarnessRuntimePath(filePath) || isHarnessSecretPath(filePath),
  );
  if (unsafe.length > 0) {
    // Best-effort unstage, then fail hard.
    await executeCommand({
      command: "git",
      args: ["reset", "HEAD", "--", ...unsafe],
      cwd,
    });
    throw new Error(
      [
        "Harness checkpoint aborted: staged files included runtime/secret paths.",
        ...unsafe.map(filePath => `- ${filePath}`),
      ].join("\n"),
    );
  }
}

/** Consumer-relevant dirty paths remaining after runtime/secret filtering. */
export async function listHarnessConsumerDirtyPaths(cwd: string): Promise<string[]> {
  const { commitable, skippedSecrets } = filterCommitableHarnessEntries(
    await readWorkingTreeEntries(cwd),
  );
  // Secrets left uncommitted still count as "not clean" for completion reporting.
  return [...commitable, ...skippedSecrets].map(entry => entry.path);
}

export async function commandExists(command: string, cwd: string): Promise<boolean> {
  if (process.platform === "win32") {
    const result = await executeCommand({
      command: "where",
      args: [command],
      cwd,
    });
    return result.exitCode === 0;
  }

  const result = await executeCommand({
    command: "sh",
    args: ["-c", `command -v ${shellQuote(command)}`],
    cwd,
  });
  return result.exitCode === 0;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
