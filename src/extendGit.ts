import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import type { WorkspaceGitCommitResult } from "./workspaceGit.js";

export const HARNESS_EXTEND_BRANCH_PREFIX = "harness/extend-";

/** Paths that must never be committed / must not block clean continue. */
export const EXTEND_RUNTIME_PATH_PREFIXES = [
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

export const EXTEND_RUNTIME_PATH_NAMES = new Set([
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

export function isHarnessExtendBranch(branch: string | null | undefined): boolean {
  return Boolean(branch && branch.startsWith(HARNESS_EXTEND_BRANCH_PREFIX));
}

export function slugifyForBranch(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "extension";
}

export function buildExtendBranchName(specSlug: string, shortId?: string): string {
  const id = shortId ?? randomBytes(3).toString("hex");
  return `${HARNESS_EXTEND_BRANCH_PREFIX}${slugifyForBranch(specSlug)}-${id}`;
}

export function isExtendRuntimePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (EXTEND_RUNTIME_PATH_NAMES.has(normalized)) {
    return true;
  }
  return EXTEND_RUNTIME_PATH_PREFIXES.some(
    prefix => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

export function filterRelevantDirtyEntries(entries: GitWorkingTreeEntry[]): GitWorkingTreeEntry[] {
  return entries.filter(entry => {
    if (isExtendRuntimePath(entry.path)) return false;
    if (entry.origPath && isExtendRuntimePath(entry.origPath)) return false;
    // Ignore harness-injected MCP churn for cleanliness / continue decisions.
    if (entry.path === ".cursor/mcp.json" || entry.path.endsWith("/.cursor/mcp.json")) {
      return false;
    }
    return true;
  });
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

export async function assertWorkingTreeCleanForExtendStart(cwd: string): Promise<void> {
  const entries = filterRelevantDirtyEntries(await readWorkingTreeEntries(cwd));
  if (entries.length === 0) return;

  const preview = entries
    .slice(0, 12)
    .map(entry => `${entry.code} ${entry.path}`)
    .join("\n");
  const more = entries.length > 12 ? `\n...and ${entries.length - 12} more` : "";
  throw new Error(
    [
      "Extend requires a completely clean working tree on a normal branch (no auto-stash).",
      "Commit or discard local changes, then re-run.",
      preview + more,
    ].join("\n"),
  );
}

/**
 * Create and checkout `harness/extend-<slug>-<short-id>` from the current HEAD.
 * Caller must already be on a clean, attached, non-harness branch.
 */
export async function createAndCheckoutExtendBranch(
  cwd: string,
  specSlug: string,
  shortId?: string,
): Promise<{ branch: string; headSha: string }> {
  const branch = buildExtendBranchName(specSlug, shortId);
  await executeCommandOrThrow({
    command: "git",
    args: ["checkout", "-b", branch],
    cwd,
  });
  const headSha = await resolveHeadSha(cwd);
  return { branch, headSha };
}

/**
 * Commit consumer-relevant changes for an extend attempt.
 * Never stages runtime/cache/vendor/secrets paths.
 */
export async function commitExtendAttempt(
  workspacePath: string,
  attempt: number,
  passed: boolean,
  findingCount: number,
): Promise<WorkspaceGitCommitResult> {
  const message = `harness: extension attempt ${attempt} ${passed ? "passed" : "failed"} (${findingCount} finding(s))`;
  const relevant = filterRelevantDirtyEntries(await readWorkingTreeEntries(workspacePath));
  if (relevant.length === 0) {
    return { committed: false, message };
  }

  const paths = relevant.map(entry => entry.path);
  // Stage explicitly — never `git add -A`.
  await executeCommandOrThrow({
    command: "git",
    args: ["add", "--", ...paths],
    cwd: workspacePath,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["commit", "-m", message],
    cwd: workspacePath,
  });

  return {
    committed: true,
    commitSha: await resolveHeadSha(workspacePath),
    message,
  };
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
