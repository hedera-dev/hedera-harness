import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativeDir, pathExists } from "./fsUtils.js";
import { ISOLATED_SKILLS_DIR } from "./runtimePaths.js";

const REFERENCES_DIRNAME = "references";

export interface VendoredSkill {
  name: string;
  relativePath: string;
  description: string;
  sourcePath: string;
  referencesPath?: string;
}

export interface VendorSkillsOptions {
  /** Relative directory under the workspace (default: `.harness-skills`). */
  skillsDir?: string;
}

export async function vendorSkills(
  workspacePath: string,
  sourceSkillPaths: string[],
  options: VendorSkillsOptions = {},
): Promise<VendoredSkill[]> {
  const skillsDir = normalizeRelativeDir(options.skillsDir ?? ISOLATED_SKILLS_DIR);
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
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "skill";
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
