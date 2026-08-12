import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { logPhase } from "./attemptLoop.js";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import type { CommandExecutionResult, PreflightCommandConfig } from "./types.js";

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_SCAFFOLD_REPO = "https://github.com/hedera-dev/scaffold-hbar.git";
export const DEFAULT_SCAFFOLD_REF = "main";
const INITIAL_COMMIT_MESSAGE = "Initial scaffold from scaffold-hbar";
/** scaffold-hbar keeps one template per branch under this prefix. */
export const TEMPLATE_BRANCH_PREFIX = "templates/";

/**
 * Resolve `--template <name>` to its branch.
 *
 * Templates are branches, not directories, so a bare name has to be prefixed.
 * A fully-qualified ref is passed through, so `--template templates/x` and
 * `--ref some-branch` both still work.
 */
export function resolveTemplateRef(template: string): string {
  const trimmed = template.trim();
  return trimmed.includes("/") ? trimmed : `${TEMPLATE_BRANCH_PREFIX}${trimmed}`;
}

/** Template branch names on a scaffold repo, for error messages. */
export async function listTemplateBranches(repo: string): Promise<string[]> {
  const result = await executeCommand({
    command: "git",
    args: ["ls-remote", "--heads", repo, `refs/heads/${TEMPLATE_BRANCH_PREFIX}*`],
    cwd: process.cwd(),
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) return [];

  return result.stdout
    .split("\n")
    .map(line => line.split("refs/heads/")[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map(branch => branch.slice(TEMPLATE_BRANCH_PREFIX.length))
    .sort();
}

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
 * Clone scaffold-hbar into `targetDir`, then replace the cloned `.git` with a
 * fresh repository and an initial commit (no scaffold-hbar history or remote).
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
  logPhase("Cloning scaffold project", `${repo}@${ref} → ${targetDir}`);
  const clone = await executeCommand({
    command: "git",
    args: ["clone", "--branch", ref, "--single-branch", repo, targetDir],
    cwd: path.dirname(targetDir),
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    streamOutput: true,
  });
  if (clone.exitCode !== 0) {
    // A wrong template name is the likely cause, so name the real options
    // rather than leaving the user with git's "remote branch not found".
    const available = await listTemplateBranches(repo);
    throw new Error(
      [
        `Could not clone ${repo} at ref ${JSON.stringify(ref)}.`,
        available.length > 0
          ? `Available templates: ${available.join(", ")}.`
          : "Could not list templates from the remote.",
        clone.stderr.trim(),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  const scaffoldSha = (
    await executeCommandOrThrow({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: targetDir,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    })
  ).stdout.trim();
  logPhase("Scaffold cloned", `${scaffoldSha.slice(0, 8)} (will re-init git)`);

  await reinitializeFreshGitRepo(targetDir);

  const commitSha = (
    await executeCommandOrThrow({
      command: "git",
      args: ["rev-parse", "HEAD"],
      cwd: targetDir,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    })
  ).stdout.trim();
  logPhase("Fresh git repository ready", `${commitSha.slice(0, 8)} on main (no remote)`);

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

async function reinitializeFreshGitRepo(targetDir: string): Promise<void> {
  logPhase("Creating fresh git repository", "discarding scaffold-hbar history and remote");
  await rm(path.join(targetDir, ".git"), { recursive: true, force: true });

  await executeCommandOrThrow({
    command: "git",
    args: ["init", "-b", "main"],
    cwd: targetDir,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  await executeCommandOrThrow({
    command: "git",
    args: ["add", "-A"],
    cwd: targetDir,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  await executeCommandOrThrow({
    command: "git",
    args: [
      "-c",
      "user.name=hedera-harness",
      "-c",
      "user.email=hedera-harness@local",
      "commit",
      "-m",
      INITIAL_COMMIT_MESSAGE,
    ],
    cwd: targetDir,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });
}

async function assertTargetReadyForInit(
  targetDir: string,
): Promise<{ emptyExisting: boolean }> {
  const mode = await detectInitMode(targetDir);
  if (mode.kind === "in-place") {
    throw new Error(`Init target directory is not empty: ${targetDir}`);
  }
  return { emptyExisting: mode.kind === "seed-empty" };
}

export type InitMode =
  | { kind: "seed-new" }
  | { kind: "seed-empty" }
  | { kind: "in-place" };

/**
 * Decide whether `init` clones a scaffold or adopts the project already here.
 *
 * A missing or empty target is bootstrapped from scaffold-hbar. A directory that
 * already looks like a project is adopted in place — which is how someone adds
 * the harness to an app they scaffolded through create-hbar, or to any existing
 * repo. A non-empty directory that is *not* a project is refused rather than
 * guessed at: provisioning into an arbitrary folder is not a recoverable mistake.
 */
export async function detectInitMode(targetDir: string): Promise<InitMode> {
  let entries: string[];
  try {
    const stats = await stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Init target exists and is not a directory: ${targetDir}`);
    }
    entries = await readdir(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "seed-new" };
    }
    throw error;
  }

  if (entries.length === 0) {
    return { kind: "seed-empty" };
  }
  if (entries.includes("package.json")) {
    return { kind: "in-place" };
  }

  throw new Error(
    [
      `Init target directory is not empty and does not look like a project: ${targetDir}`,
      `Found ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (e.g. ${entries.slice(0, 5).join(", ")}) but no package.json.`,
      "Choose an empty directory to scaffold into, or run init inside a project to adopt the harness there.",
    ].join("\n"),
  );
}

async function runPreflightCommands(
  cwd: string,
  commands: Array<string | PreflightCommandConfig>,
): Promise<CommandExecutionResult[]> {
  const results: CommandExecutionResult[] = [];
  for (const commandConfig of commands) {
    const normalized =
      typeof commandConfig === "string" ? { command: commandConfig } : commandConfig;
    const label = normalized.name ?? normalized.command;
    logPhase("Init preflight", label);
    const result = await executeCommand({
      command: normalized.command,
      cwd,
      timeoutMs: normalized.timeoutMs,
      shell: true,
      streamOutput: true,
    });
    results.push(result);
    if (result.exitCode !== 0) {
      const named = normalized.name ? ` "${normalized.name}"` : "";
      throw new Error(`Init preflight${named} failed for command "${normalized.command}".`);
    }
    logPhase(
      "Init preflight finished",
      `${label} exit=${result.exitCode} durationMs=${result.durationMs}`,
    );
  }
  return results;
}
