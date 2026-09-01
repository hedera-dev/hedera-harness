import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { envSkillsRef, envSkillsRepo } from "./env.js";
import { normalizeRelativeDir, pathExists } from "./fsUtils.js";
import { ensureSkillRepoCheckout } from "./skillRepoCache.js";

export const DEFAULT_SKILLS_REPO = "https://github.com/hedera-dev/hedera-skills.git";
export const DEFAULT_SKILLS_REF = "master";

/**
 * Marketplace plugins whose SKILL.md files are offered to the generator.
 * Authoring / CLI / hackathon / agent-kit plugins stay Cursor marketplace skills.
 */
export const PRODUCT_SKILL_PLUGINS = [
  "native-services-js",
  "system-contracts",
  "cross-chain",
  "dev-intelligence",
] as const;

const REFERENCES_DIRNAME = "references";

export interface VendoredSkill {
  name: string;
  relativePath: string;
  description: string;
  sourcePath: string;
  referencesPath?: string;
}

/**
 * Clone the skills repo (cached under `<projectRoot>/.skill-cache/`) and vendor
 * every product-plugin SKILL.md into the workspace. The generator picks what the
 * PRD needs; authoring and CLI plugins are not copied.
 */
export async function provideSkills(input: {
  /** Root that owns the `.skill-cache/` checkout. */
  projectRoot: string;
  /** Root the skills are copied into. */
  workspacePath: string;
  /** Relative directory under `workspacePath` to vendor into. */
  skillsDir: string;
  /** Skills git remote. Defaults to `HARNESS_SKILLS_REPO` or `hedera-dev/hedera-skills`. */
  repo?: string;
  /** Skills git ref. Defaults to `HARNESS_SKILLS_REF` or `master`. */
  ref?: string;
}): Promise<VendoredSkill[]> {
  const repo = input.repo?.trim() || envSkillsRepo() || DEFAULT_SKILLS_REPO;
  const ref = input.ref?.trim() || envSkillsRef() || DEFAULT_SKILLS_REF;
  const { checkoutPath } = await ensureSkillRepoCheckout({
    projectRoot: input.projectRoot,
    repo,
    ref,
  });
  const sourceSkillPaths = await discoverProductSkillPaths(checkoutPath);
  return vendorResolvedSkills(input.workspacePath, input.skillsDir, sourceSkillPaths);
}

async function discoverProductSkillPaths(checkoutPath: string): Promise<string[]> {
  const pluginsRoot = path.join(checkoutPath, "plugins");
  if (!(await pathExists(pluginsRoot))) {
    throw new Error(
      `Skills checkout at ${checkoutPath} has no plugins/ directory. Check HARNESS_SKILLS_REPO / HARNESS_SKILLS_REF.`,
    );
  }

  const found: string[] = [];
  for (const plugin of PRODUCT_SKILL_PLUGINS) {
    const skillsRoot = path.join(pluginsRoot, plugin, "skills");
    if (!(await pathExists(skillsRoot))) {
      continue;
    }
    const entries = await readdir(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMd = path.join(skillsRoot, entry.name, "SKILL.md");
      if (await pathExists(skillMd)) {
        found.push(skillMd);
      }
    }
  }

  found.sort();
  if (found.length === 0) {
    throw new Error(
      [
        `No product skills found under ${pluginsRoot}.`,
        `Looked in: ${PRODUCT_SKILL_PLUGINS.join(", ")}.`,
        "Authoring, CLI, hackathon, and agent-kit plugins are not offered to the generator.",
      ].join(" "),
    );
  }
  return found;
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
