import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureSkillRepoCheckout } from "./skillRepoCache.js";

export const SKILLS_INDEX_FILENAME = "skills-index.json";
export const DEFAULT_SKILLS_REPO = "https://github.com/hedera-dev/hedera-skills.git";
export const DEFAULT_SKILLS_REF = "master";

export interface SkillsIndexEntry {
  name: string;
  /** Local filesystem path, or in-repo path when `repo` / index `defaults.repo` is set. */
  path: string;
  /** Optional per-skill git remote (overrides `defaults.repo`). */
  repo?: string;
  /** Optional per-skill git ref (overrides `defaults.ref`). */
  ref?: string;
  tags?: string[];
  description?: string;
}

export interface SkillsIndexDefaults {
  repo?: string;
  ref?: string;
}

interface SkillsIndexFile {
  description?: string;
  defaults?: SkillsIndexDefaults;
  skills: SkillsIndexEntry[];
}

interface LoadedSkillsIndex {
  byName: Map<string, SkillsIndexEntry>;
  defaults: SkillsIndexDefaults;
  indexPath: string;
}

/**
 * Resolve skill refs from a template spec to absolute SKILL.md paths on disk.
 *
 * - Absolute paths and `./` / `../` relative paths are used as-is (relative to projectRoot).
 * - Everything else is treated as a skill name and looked up in `skills-index.json`.
 * - Index entries may point at local files or at paths inside a remote git repo
 *   (`defaults.repo` / entry `repo` + `ref`). Remote skills are cached under `.skill-cache/`.
 */
export async function resolveSkillPaths(
  skillRefs: string[],
  projectRoot: string,
): Promise<string[]> {
  if (skillRefs.length === 0) {
    return [];
  }

  const needsIndex = skillRefs.some(ref => !isPathLike(ref));
  const index = needsIndex ? await loadSkillsIndex(projectRoot) : undefined;
  const checkoutCache = new Map<string, string>();

  const resolved: string[] = [];
  for (const ref of skillRefs) {
    const trimmed = ref.trim();
    if (!trimmed) {
      throw new Error("skills entries must be non-empty skill names or paths.");
    }

    if (isPathLike(trimmed)) {
      const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(projectRoot, trimmed);
      await assertSkillFileExists(absolute, `path ${JSON.stringify(trimmed)}`);
      resolved.push(absolute);
      continue;
    }

    if (!index) {
      throw new Error(
        [
          `Unknown skill name ${JSON.stringify(trimmed)}.`,
          `Create ${path.join(projectRoot, SKILLS_INDEX_FILENAME)} and add an entry, or use an absolute/relative path.`,
        ].join(" "),
      );
    }

    const entry = index.byName.get(trimmed);
    if (!entry) {
      const available = [...index.byName.keys()].sort();
      throw new Error(
        [
          `Unknown skill name ${JSON.stringify(trimmed)}.`,
          available.length > 0
            ? `Available skills in ${index.indexPath}: ${available.join(", ")}.`
            : `No skills are registered in ${index.indexPath}.`,
          "Add an entry to skills-index.json or use an absolute/relative path to a SKILL.md file.",
        ].join(" "),
      );
    }

    const absolute = await resolveIndexEntryPath(entry, index, projectRoot, checkoutCache);
    await assertSkillFileExists(
      absolute,
      `skill ${JSON.stringify(trimmed)} (from ${index.indexPath})`,
    );
    resolved.push(absolute);
  }

  return resolved;
}

export function skillsIndexPath(projectRoot: string): string {
  return path.join(projectRoot, SKILLS_INDEX_FILENAME);
}

/** Absolute, or relative with an explicit ./ or ../ prefix. */
export function isPathLike(ref: string): boolean {
  return path.isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../");
}

async function resolveIndexEntryPath(
  entry: SkillsIndexEntry,
  index: LoadedSkillsIndex,
  projectRoot: string,
  checkoutCache: Map<string, string>,
): Promise<string> {
  // Explicit local filesystem paths always win.
  if (isPathLike(entry.path)) {
    return path.isAbsolute(entry.path) ? entry.path : path.resolve(projectRoot, entry.path);
  }

  const repo = entry.repo?.trim() || index.defaults.repo?.trim();
  if (!repo) {
    // No remote configured — treat path as project-relative.
    return path.resolve(projectRoot, entry.path);
  }

  const ref = entry.ref?.trim() || index.defaults.ref?.trim() || DEFAULT_SKILLS_REF;
  const cacheKey = `${repo}@@${ref}`;
  let checkoutPath = checkoutCache.get(cacheKey);
  if (!checkoutPath) {
    const checkout = await ensureSkillRepoCheckout({ projectRoot, repo, ref });
    checkoutPath = checkout.checkoutPath;
    checkoutCache.set(cacheKey, checkoutPath);
  }

  const inRepoPath = entry.path.replace(/^\.\/+/, "");
  if (path.isAbsolute(inRepoPath) || inRepoPath.startsWith("..")) {
    throw new Error(
      `Skill ${JSON.stringify(entry.name)} path ${JSON.stringify(entry.path)} must be a path inside the skill repo (no absolute or .. segments).`,
    );
  }

  return path.resolve(checkoutPath, inRepoPath);
}

async function loadSkillsIndex(projectRoot: string): Promise<LoadedSkillsIndex> {
  const indexPath = skillsIndexPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch {
    throw new Error(
      [
        `Skill name lookup requires ${indexPath}, but that file was not found.`,
        "Create skills-index.json at the harness repo root (see README), or use absolute/relative paths in the spec's skills list.",
      ].join(" "),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${indexPath} as JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected object root in ${indexPath}.`);
  }

  const root = parsed as SkillsIndexFile;
  const skillsRaw = root.skills;
  if (!Array.isArray(skillsRaw)) {
    throw new Error(`Expected array "skills" in ${indexPath}.`);
  }

  const defaults = readDefaults(root.defaults, indexPath);

  const byName = new Map<string, SkillsIndexEntry>();
  for (const [index, item] of skillsRaw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Expected object at skills[${index}] in ${indexPath}.`);
    }
    const record = item as unknown as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const skillPath = typeof record.path === "string" ? record.path.trim() : "";
    if (!name) {
      throw new Error(`skills[${index}].name must be a non-empty string in ${indexPath}.`);
    }
    if (!skillPath) {
      throw new Error(`skills[${index}].path must be a non-empty string in ${indexPath}.`);
    }
    if (byName.has(name)) {
      throw new Error(
        `Duplicate skill name ${JSON.stringify(name)} in ${indexPath}. Skill names must be unique.`,
      );
    }

    const entry: SkillsIndexEntry = {
      name,
      path: skillPath,
    };
    if (typeof record.repo === "string" && record.repo.trim()) {
      entry.repo = record.repo.trim();
    }
    if (typeof record.ref === "string" && record.ref.trim()) {
      entry.ref = record.ref.trim();
    }
    if (Array.isArray(record.tags) && record.tags.every(tag => typeof tag === "string")) {
      entry.tags = record.tags as string[];
    }
    if (typeof record.description === "string" && record.description.trim()) {
      entry.description = record.description.trim();
    }
    byName.set(name, entry);
  }

  return { byName, defaults, indexPath };
}

function readDefaults(
  defaults: SkillsIndexDefaults | undefined,
  indexPath: string,
): SkillsIndexDefaults {
  if (defaults === undefined) {
    return {
      repo: DEFAULT_SKILLS_REPO,
      ref: DEFAULT_SKILLS_REF,
    };
  }
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new Error(`Expected object "defaults" in ${indexPath}.`);
  }

  const repo =
    typeof defaults.repo === "string" && defaults.repo.trim()
      ? defaults.repo.trim()
      : DEFAULT_SKILLS_REPO;
  const ref =
    typeof defaults.ref === "string" && defaults.ref.trim()
      ? defaults.ref.trim()
      : DEFAULT_SKILLS_REF;

  return { repo, ref };
}

async function assertSkillFileExists(absolutePath: string, label: string): Promise<void> {
  try {
    await access(absolutePath);
  } catch {
    throw new Error(
      [
        `Resolved ${label} to ${JSON.stringify(absolutePath)}, which does not exist.`,
        "Update skills-index.json (or the path in the spec) to point at a real SKILL.md file.",
      ].join(" "),
    );
  }
}
