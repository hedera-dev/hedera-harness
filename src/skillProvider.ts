import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRelativeDir, pathExists } from "./fsUtils.js";
import { ensureSkillRepoCheckout } from "./skillRepoCache.js";

const SKILLS_INDEX_FILENAME = "skills-index.json";
const DEFAULT_SKILLS_REPO = "https://github.com/hedera-dev/hedera-skills.git";
const DEFAULT_SKILLS_REF = "master";
const REFERENCES_DIRNAME = "references";

export interface VendoredSkill {
  name: string;
  relativePath: string;
  description: string;
  sourcePath: string;
  referencesPath?: string;
}

interface SkillsIndexEntry {
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

interface SkillsIndexDefaults {
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
 * Resolve skill refs and vendor them into the workspace in one step.
 *
 * - `skillRefs` are skill names from `skills-index.json`, or absolute / `./` / `../` paths.
 * - Index entries may live on disk or inside a remote git repo, which is cached under
 *   `<projectRoot>/.skill-cache/`.
 * - Copies land in `<workspacePath>/<skillsDir>/<slug>/SKILL.md` alongside a `manifest.json`.
 *   The manifest is written even for an empty ref list so callers can rely on the directory.
 */
export async function provideSkills(input: {
  skillRefs: string[];
  /** Root that owns `skills-index.json` and the `.skill-cache/` checkout. */
  projectRoot: string;
  /** Root the skills are copied into. */
  workspacePath: string;
  /** Relative directory under `workspacePath` to vendor into. */
  skillsDir: string;
}): Promise<VendoredSkill[]> {
  const sourceSkillPaths = await resolveSkillPaths(input.skillRefs, input.projectRoot);
  return vendorResolvedSkills(input.workspacePath, input.skillsDir, sourceSkillPaths);
}

/**
 * Locate the skills index and read the names it registers.
 *
 * Prefers a project-local `skills-index.json`, then the package-bundled copy so
 * npm-installed `hedera-harness` works without cloning this repo. `localPath` is where
 * `init` copies `sourcePath` to.
 */
export async function resolveSkillsIndex(projectRoot: string): Promise<{
  sourcePath: string;
  localPath: string;
  names: string[];
}> {
  const index = await loadSkillsIndex(projectRoot);
  return {
    sourcePath: index.indexPath,
    localPath: localSkillsIndexPath(projectRoot),
    names: [...index.byName.keys()].sort(),
  };
}

async function resolveSkillPaths(skillRefs: string[], projectRoot: string): Promise<string[]> {
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

async function vendorResolvedSkills(
  workspacePath: string,
  requestedSkillsDir: string,
  sourceSkillPaths: string[],
): Promise<VendoredSkill[]> {
  const skillsDir = normalizeRelativeDir(requestedSkillsDir);
  const skillsRoot = path.join(workspacePath, skillsDir);
  await mkdir(skillsRoot, { recursive: true });

  const vendored: VendoredSkill[] = [];
  const usedSlugs = new Set<string>();

  for (const sourcePath of sourceSkillPaths) {
    const content = await readFile(sourcePath, "utf8");
    const name = extractSkillName(content) ?? path.basename(path.dirname(sourcePath));
    const description = extractSkillDescription(content);
    const slug = uniqueSlug(slugify(name), usedSlugs);
    const relativePath = path.posix.join(skillsDir, slug, "SKILL.md");
    const destinationPath = path.join(workspacePath, ...relativePath.split("/"));

    await mkdir(path.dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, content, "utf8");

    const skill: VendoredSkill = {
      name,
      relativePath,
      description,
      sourcePath,
    };

    const sourceReferencesDir = path.join(path.dirname(sourcePath), REFERENCES_DIRNAME);
    const destReferencesDir = path.join(path.dirname(destinationPath), REFERENCES_DIRNAME);
    if (await pathExists(sourceReferencesDir)) {
      await cp(sourceReferencesDir, destReferencesDir, { recursive: true, force: true });
      skill.referencesPath = path.posix.join(skillsDir, slug, REFERENCES_DIRNAME);
    }

    vendored.push(skill);
  }

  await writeFile(
    path.join(skillsRoot, "manifest.json"),
    `${JSON.stringify(
      {
        vendoredAt: new Date().toISOString(),
        skills: vendored.map(skill => ({
          name: skill.name,
          relativePath: skill.relativePath,
          sourcePath: skill.sourcePath,
          ...(skill.referencesPath ? { referencesPath: skill.referencesPath } : {}),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return vendored;
}

/** Absolute, or relative with an explicit ./ or ../ prefix. */
function isPathLike(ref: string): boolean {
  return path.isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../");
}

function localSkillsIndexPath(projectRoot: string): string {
  return path.join(projectRoot, SKILLS_INDEX_FILENAME);
}

/** Package-bundled index next to installed `dist/` (npm consumers without a local clone). */
function bundledSkillsIndexPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", SKILLS_INDEX_FILENAME);
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

async function resolveSkillsIndexPath(projectRoot: string): Promise<string> {
  const localPath = localSkillsIndexPath(projectRoot);
  if (await pathExists(localPath)) {
    return localPath;
  }

  const bundledPath = bundledSkillsIndexPath();
  if (await pathExists(bundledPath)) {
    return bundledPath;
  }

  throw new Error(
    [
      `Skill name lookup requires ${localPath} (or the package-bundled ${SKILLS_INDEX_FILENAME}).`,
      "Neither file was found.",
      "Create skills-index.json in the consumer project, reinstall hedera-harness, or use absolute/relative paths in the spec's skills list.",
    ].join(" "),
  );
}

async function loadSkillsIndex(projectRoot: string): Promise<LoadedSkillsIndex> {
  const indexPath = await resolveSkillsIndexPath(projectRoot);

  let raw: string;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read skills index at ${indexPath}: ${message}`);
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
  if (await pathExists(absolutePath)) {
    return;
  }
  throw new Error(
    [
      `Resolved ${label} to ${JSON.stringify(absolutePath)}, which does not exist.`,
      "Update skills-index.json (or the path in the spec) to point at a real SKILL.md file.",
    ].join(" "),
  );
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

function uniqueSlug(base: string, used: Set<string>): string {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function extractSkillName(content: string): string | undefined {
  const match = content.match(/^name:\s*(.+)$/m);
  return match?.[1]?.trim();
}

function extractSkillDescription(content: string): string {
  const match = content.match(/^description:\s*(.+)$/m);
  return match?.[1]?.trim() ?? "Use this skill when relevant to the template being built.";
}
