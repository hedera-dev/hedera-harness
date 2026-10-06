import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A git invocation that failed, carrying git's own stderr rather than node's wrapper text. */
export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")}: ${stderr.trim() || "failed"}`);
    this.name = "GitError";
  }
}

async function gitRaw(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new GitError(args, stderr);
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await gitRaw(args, cwd)).trim();
}

/**
 * Absolute path to the repository containing `cwd`.
 * Throws if `cwd` is not inside a work tree — the harness always runs from a repo.
 */
export async function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export async function headCommit(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

/**
 * Paths changed in the work tree, minus `ignoring`.
 *
 * The clean-tree check guarantees a known starting point for the project's
 * code. A spec is an input to the run rather than a change to the project, so
 * it does not count as dirt — otherwise writing one and running is refused.
 */
export async function dirtyPaths(cwd: string, ignoring: string[] = []): Promise<string[]> {
  const changed = await changedPaths(cwd);
  return changed.filter((path) => !ignoring.includes(path));
}

/**
 * True when `path` is tracked. Ignore rules never apply to tracked files, so a
 * tracked `.harness/` cannot be excluded and would fail the clean check forever.
 */
export async function isTracked(path: string, cwd: string): Promise<boolean> {
  return (await git(["ls-files", "--", path], cwd)) !== "";
}

/** Creates `name` from the current commit and switches to it. */
export async function createBranch(name: string, cwd: string): Promise<void> {
  await git(["switch", "--create", name], cwd);
}

/** Switches to an existing branch. */
export async function switchBranch(name: string, cwd: string): Promise<void> {
  await git(["switch", name], cwd);
}

/** Stages `paths` and commits them. Nothing else in the tree is touched. */
export async function commit(paths: string[], message: string, cwd: string): Promise<void> {
  await git(["add", "--", ...paths], cwd);
  await git(["commit", "--message", message, "--", ...paths], cwd);
}

/**
 * Two things never reach a run's commits.
 *
 * Inputs to the run: a spec living in the repo would be swept onto the run
 * branch and then deleted from the working tree when the run switched back.
 *
 * Dotenv files, whatever the working tree holds. The generator's hook refuses
 * the obvious writes, but no pattern beats an interpreter — so this is the
 * enforceable half, because the harness owns staging.
 */
const SECRET_FILE = /(^|\/)\.env(?!\.(example|sample|template|dist|defaults)$)(\.[^/]*)?$/;

/**
 * Paths changed in the work tree, tracked or not, excluding anything ignored.
 * Reads untrimmed output on purpose: the status code occupies the first two
 * columns and an unmodified index leaves column one blank, so trimming would
 * shift the first line and eat a character off its path.
 */
export async function changedPaths(cwd: string): Promise<string[]> {
  const status = await gitRaw(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  return status
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3);
      // Renames read `R  old -> new`; only the new path exists to stage.
      const arrow = path.indexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .map((path) => path.replace(/^"|"$/g, ""));
}

/**
 * Commits everything the agent changed except secrets. Returns the new commit,
 * or null when there was nothing to commit — an attempt that changed no files
 * is a real outcome, not an error.
 */
export async function commitWork(
  message: string,
  cwd: string,
  exclude: string[] = [],
): Promise<string | null> {
  const paths = await changedPaths(cwd);
  const safe = paths.filter((path) => !SECRET_FILE.test(path) && !exclude.includes(path));
  if (safe.length === 0) return null;

  await git(["add", "--", ...safe], cwd);
  if ((await git(["diff", "--cached", "--name-only"], cwd)) === "") return null;
 
  /**
   * `--no-verify` because the project's own gate is the TEST stage, which the
   * harness runs deliberately and feeds into the repair loop.
   */
  await git(["commit", "--no-verify", "--message", message], cwd);
  return headCommit(cwd);
}

/** Exported for tests: whether a path would be kept out of a commit. */
export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path);
}
