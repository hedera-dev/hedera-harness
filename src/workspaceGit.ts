import { access } from "node:fs/promises";
import path from "node:path";
import { executeCommand, executeCommandOrThrow } from "./command.js";

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "hedera-harness",
  GIT_AUTHOR_EMAIL: "harness@local",
  GIT_COMMITTER_NAME: "hedera-harness",
  GIT_COMMITTER_EMAIL: "harness@local",
};

export interface WorkspaceGitInitResult {
  commitSha: string;
}

export interface WorkspaceGitCommitResult {
  committed: boolean;
  commitSha?: string;
  message: string;
}

export async function initWorkspaceGit(workspacePath: string): Promise<WorkspaceGitInitResult> {
  await executeCommandOrThrow({
    command: "git",
    args: ["init", "--template="],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["add", "-A"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["commit", "-m", "harness: seeded workspace with skills and context"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  return {
    commitSha: await resolveHeadCommitSha(workspacePath),
  };
}

/** Initialize git only when missing; never re-init an existing repo. */
export async function ensureWorkspaceGit(
  workspacePath: string,
): Promise<{ initialized: boolean; commitSha: string }> {
  try {
    await access(path.join(workspacePath, ".git"));
    return {
      initialized: false,
      commitSha: await resolveHeadCommitSha(workspacePath),
    };
  } catch {
    const result = await initWorkspaceGit(workspacePath);
    return { initialized: true, commitSha: result.commitSha };
  }
}

/** Commit vendored context / manual edits before a continue cycle. */
export async function commitWorkspaceBaseline(
  workspacePath: string,
  message: string,
): Promise<WorkspaceGitCommitResult> {
  const status = await executeCommand({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  if (!status.stdout.trim()) {
    return { committed: false, message };
  }

  await executeCommandOrThrow({
    command: "git",
    args: ["add", "-A"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["commit", "-m", message],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  return {
    committed: true,
    commitSha: await resolveHeadCommitSha(workspacePath),
    message,
  };
}

export async function commitWorkspaceAttempt(
  workspacePath: string,
  attempt: number,
  passed: boolean,
  findingCount: number,
): Promise<WorkspaceGitCommitResult> {
  const status = await executeCommand({
    command: "git",
    args: ["status", "--porcelain"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  const message = `harness: attempt ${attempt} ${passed ? "passed" : "failed"} (${findingCount} finding(s))`;

  if (!status.stdout.trim()) {
    return { committed: false, message };
  }

  await executeCommandOrThrow({
    command: "git",
    args: ["add", "-A"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["commit", "-m", message],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  return {
    committed: true,
    commitSha: await resolveHeadCommitSha(workspacePath),
    message,
  };
}

async function resolveHeadCommitSha(workspacePath: string): Promise<string> {
  const result = await executeCommandOrThrow({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: workspacePath,
    env: GIT_IDENTITY_ENV,
  });

  return result.stdout.trim();
}
