import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { executeCommand, executeCommandOrThrow } from "./command.js";
import { pathExists } from "./fsUtils.js";
import { SKILL_CACHE_DIRNAME } from "./runtimePaths.js";

const DEFAULT_GIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The cache sits under the project root, so a clone's loose-object paths land
 * deep. Git for Windows refuses anything over MAX_PATH unless core.longpaths is
 * on, and fails the clone with "Filename too long". Set per invocation rather
 * than writing to the user's git config.
 */
const GIT_LONG_PATH_ARGS = process.platform === "win32" ? ["-c", "core.longpaths=true"] : [];

/** Cached clone of `repo` at `ref` under `<projectRoot>/.skill-cache/<hash>/`. */
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
    await executeCommandOrThrow({
      command: "git",
      args: [...GIT_LONG_PATH_ARGS, "clone", "--no-checkout", input.repo, checkoutPath],
      cwd: cacheRoot,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
  }

  await executeCommandOrThrow({
    command: "git",
    args: [...GIT_LONG_PATH_ARGS, "fetch", "--tags", "--prune", "origin"],
    cwd: checkoutPath,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  const commitSha = await resolveCommitSha(checkoutPath, input.ref);

  await executeCommandOrThrow({
    command: "git",
    args: [...GIT_LONG_PATH_ARGS, "checkout", "--detach", "--force", commitSha],
    cwd: checkoutPath,
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  });

  return { checkoutPath, commitSha };
}

function cacheKeyForRepo(repo: string): string {
  const normalized = repo.trim().replace(/\.git$/i, "").toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  // The hash disambiguates; the slug only exists so `ls .skill-cache` reads as
  // something. Keep it short — a local-path repo turns into 48 characters of
  // directory names that say nothing, and every one of them is MAX_PATH budget
  // spent before git even starts writing objects.
  const slug = normalized
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/[:/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  return `${slug || "repo"}-${hash}`;
}

async function resolveCommitSha(checkoutPath: string, ref: string): Promise<string> {
  const candidates = [ref, `origin/${ref}`, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`, `refs/tags/${ref}`];

  for (const candidate of [...new Set(candidates)]) {
    const result = await executeCommand({
      command: "git",
      args: [...GIT_LONG_PATH_ARGS, "rev-parse", `${candidate}^{commit}`],
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
