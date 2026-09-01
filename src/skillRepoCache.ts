import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import { pathExists } from "./fsUtils.js";

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const SKILL_CACHE_DIRNAME = ".skill-cache";

/**
 * Ensure a git repo is available under `<projectRoot>/.skill-cache/<hash>/`
 * at the requested ref, then return the local checkout path.
 *
 * Reuses an existing cache when present (fetch + checkout) so multiple skills
 * from the same repo share one clone per harness project.
 */
export async function ensureSkillRepoCheckout(input: {
  projectRoot: string;
  repo: string;
  ref: string;
}): Promise<{ checkoutPath: string; commitSha: string }> {
  const cacheRoot = path.join(input.projectRoot, SKILL_CACHE_DIRNAME);
  await mkdir(cacheRoot, { recursive: true });

  const checkoutPath = path.join(cacheRoot, cacheKeyForRepo(input.repo));
  const exists = await pathExists(path.join(checkoutPath, ".git"));

  if (!exists) {
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    await executeCommandOrThrow({
      command: "git",
      args: ["clone", "--no-checkout", input.repo, checkoutPath],
      cwd: cacheRoot,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
  }

  await executeCommandOrThrow({
    command: "git",
    args: ["fetch", "--tags", "--prune", "origin"],
    cwd: checkoutPath,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  const commitSha = await resolveCommitSha(checkoutPath, input.ref);

  await executeCommandOrThrow({
    command: "git",
    args: ["checkout", "--detach", "--force", commitSha],
    cwd: checkoutPath,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  return { checkoutPath, commitSha };
}

export function cacheKeyForRepo(repo: string): string {
  const normalized = repo.trim().replace(/\.git$/i, "").toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const slug = normalized
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/[:/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "repo"}-${hash}`;
}

async function resolveCommitSha(checkoutPath: string, ref: string): Promise<string> {
  const candidates = [ref, `origin/${ref}`, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`];

  for (const candidate of [...new Set(candidates)]) {
    const result = await executeCommand({
      command: "git",
      args: ["rev-parse", `${candidate}^{commit}`],
      cwd: checkoutPath,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }

  throw new Error(
    `Unable to resolve skill repo ref ${JSON.stringify(ref)} in ${checkoutPath}. ` +
      "Check HARNESS_SKILLS_REF (default master).",
  );
}
