import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import type { CommandExecutionResult, PreflightCommandConfig } from "./types.js";

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_SCAFFOLD_REPO = "https://github.com/hedera-dev/scaffold-hbar.git";
export const DEFAULT_SCAFFOLD_REF = "main";

export interface InitSeedInput {
  /** Absolute path where the project should be created. */
  targetDir: string;
  repo?: string;
  ref?: string;
  /** When true, skip yarn/preflight install after clone. */
  skipInstall?: boolean;
  /** Extra preflight commands after clone (in addition to default yarn install). */
  preflightCommands?: Array<string | PreflightCommandConfig>;
}

export interface InitSeedResult {
  targetDir: string;
  repo: string;
  ref: string;
  commitSha: string;
  preflight: CommandExecutionResult[];
  clonedIntoExistingEmptyDir: boolean;
}

/**
 * Clone scaffold-hbar into `targetDir`, keeping `.git` so the project is a normal repo.
 * Unlike isolated `run` seeding, this does **not** strip `.git`.
 */
export async function seedProjectForInit(input: InitSeedInput): Promise<InitSeedResult> {
  const targetDir = path.resolve(input.targetDir);
  const repo = input.repo?.trim() || DEFAULT_SCAFFOLD_REPO;
  const ref = input.ref?.trim() || DEFAULT_SCAFFOLD_REF;

  const { emptyExisting } = await assertTargetReadyForInit(targetDir);
  if (!emptyExisting) {
    await mkdir(path.dirname(targetDir), { recursive: true });
  }

  // Prefer the given repo path/URL as-is (including local checkouts). Cloning never
  // modifies the seed, so we do not rewrite local paths to `origin`.
  const cloneArgs = ["clone", "--branch", ref, "--single-branch", repo, targetDir];
  await executeCommandOrThrow({
    command: "git",
    args: cloneArgs,
    cwd: path.dirname(targetDir),
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  const commitSha = (
    await executeCommandOrThrow({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: targetDir,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    })
  ).stdout.trim();

  // Ensure we are on a named branch (clone --branch usually is).
  const branch = (
    await executeCommand({
      command: "git",
      args: ["branch", "--show-current"],
      cwd: targetDir,
    })
  ).stdout.trim();
  if (!branch) {
    await executeCommandOrThrow({
      command: "git",
      args: ["checkout", "-b", ref],
      cwd: targetDir,
    });
  }

  const preflightCommands: Array<string | PreflightCommandConfig> = input.skipInstall
    ? [...(input.preflightCommands ?? [])]
    : [
        { name: "install", command: "yarn install", timeoutMs: 300_000 },
        ...(input.preflightCommands ?? []),
      ];

  const preflight = await runPreflightCommands(targetDir, preflightCommands);

  return {
    targetDir,
    repo,
    ref,
    commitSha,
    preflight,
    clonedIntoExistingEmptyDir: emptyExisting,
  };
}

async function assertTargetReadyForInit(
  targetDir: string,
): Promise<{ emptyExisting: boolean }> {
  try {
    const stats = await stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Init target exists and is not a directory: ${targetDir}`);
    }
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(
        [
          `Init target directory is not empty: ${targetDir}`,
          `Found ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (e.g. ${entries.slice(0, 5).join(", ")}).`,
          "Choose an empty directory or a new path.",
        ].join("\n"),
      );
    }
    return { emptyExisting: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { emptyExisting: false };
    }
    throw error;
  }
}

async function runPreflightCommands(
  cwd: string,
  commands: Array<string | PreflightCommandConfig>,
): Promise<CommandExecutionResult[]> {
  const results: CommandExecutionResult[] = [];
  for (const commandConfig of commands) {
    const normalized =
      typeof commandConfig === "string" ? { command: commandConfig } : commandConfig;
    const result = await executeCommand({
      command: normalized.command,
      cwd,
      timeoutMs: normalized.timeoutMs,
      shell: true,
    });
    results.push(result);
    if (result.exitCode !== 0) {
      const label = normalized.name ? ` "${normalized.name}"` : "";
      throw new Error(`Init preflight${label} failed for command "${normalized.command}".`);
    }
  }
  return results;
}
