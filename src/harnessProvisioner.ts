import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "./fsUtils.js";
import { resolveSkillPaths, resolveSkillsIndexPath, SKILLS_INDEX_FILENAME } from "./skillResolver.js";
import { vendorSkills } from "./skillVendor.js";

export const PROJECT_HARNESS_SKELETON_DIR = "skeletons/project-harness";

export interface ProvisionHarnessInput {
  targetDir: string;
  /** Skill names to pre-vendor under `.harness/skills/`. Empty = skip. */
  skillNames?: string[];
  /** When true, also copy package-bundled skills-index.json into the project. */
  copySkillsIndex?: boolean;
}

export interface ProvisionHarnessResult {
  harnessDir: string;
  writtenFiles: string[];
  vendoredSkillFiles: string[];
  gitignoreUpdated: boolean;
  packageJsonUpdated: boolean;
}

/**
 * Provision `.harness/` recipe files, optional skills index, pre-vendored skills,
 * gitignore entries, and a `harness:run` package.json script.
 */
export async function provisionHarnessProject(
  input: ProvisionHarnessInput,
): Promise<ProvisionHarnessResult> {
  const targetDir = path.resolve(input.targetDir);
  const harnessDir = path.join(targetDir, ".harness");
  const skeletonRoot = resolveProjectHarnessSkeletonRoot();
  const writtenFiles: string[] = [];

  await mkdir(path.join(harnessDir, "validators"), { recursive: true });
  await mkdir(path.join(harnessDir, "runs"), { recursive: true });

  const copies: Array<[string, string]> = [
    ["spec.yaml", path.join(harnessDir, "spec.yaml")],
    ["prd.md", path.join(harnessDir, "prd.md")],
    ["validators/static.json", path.join(harnessDir, "validators", "static.json")],
    ["validators/yarn.json", path.join(harnessDir, "validators", "yarn.json")],
  ];

  for (const [relative, dest] of copies) {
    if (await pathExists(dest)) {
      continue;
    }
    await copyFile(path.join(skeletonRoot, relative), dest);
    writtenFiles.push(path.relative(targetDir, dest));
  }

  if (input.copySkillsIndex !== false) {
    const destIndex = path.join(targetDir, SKILLS_INDEX_FILENAME);
    if (!(await pathExists(destIndex))) {
      const sourceIndex = await resolveSkillsIndexPath(targetDir);
      await copyFile(sourceIndex, destIndex);
      writtenFiles.push(SKILLS_INDEX_FILENAME);
    }
  }

  let vendoredSkillFiles: string[] = [];
  const skillNames = input.skillNames ?? [];
  if (skillNames.length > 0) {
    const resolved = await resolveSkillPaths(skillNames, targetDir);
    const vendored = await vendorSkills(targetDir, resolved, {
      skillsDir: ".harness/skills",
    });
    vendoredSkillFiles = vendored.map(entry => entry.relativePath);
  }

  const gitignoreUpdated = await ensureHarnessGitignore(targetDir, skeletonRoot);
  const packageJsonUpdated = await ensureHarnessPackageScript(targetDir);

  // Keep an empty runs placeholder so the directory exists in a fresh clone
  // even when gitignored contents are empty.
  const keep = path.join(harnessDir, "runs", ".gitkeep");
  if (!(await pathExists(keep))) {
    await writeFile(keep, "");
    writtenFiles.push(path.relative(targetDir, keep));
  }

  return {
    harnessDir,
    writtenFiles,
    vendoredSkillFiles,
    gitignoreUpdated,
    packageJsonUpdated,
  };
}

export function resolveProjectHarnessSkeletonRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    PROJECT_HARNESS_SKELETON_DIR,
  );
}

/** List skill names from the resolved skills index (for init --all-skills). */
export async function listRegisteredSkillNames(projectRoot: string): Promise<string[]> {
  const indexPath = await resolveSkillsIndexPath(projectRoot);
  const raw = await readFile(indexPath, "utf8");
  const parsed = JSON.parse(raw) as { skills?: Array<{ name?: string }> };
  if (!Array.isArray(parsed.skills)) {
    return [];
  }
  return parsed.skills
    .map(entry => (typeof entry.name === "string" ? entry.name.trim() : ""))
    .filter(Boolean)
    .sort();
}

async function ensureHarnessGitignore(targetDir: string, skeletonRoot: string): Promise<boolean> {
  const snippetPath = path.join(skeletonRoot, "gitignore-snippet.txt");
  const snippet = (await readFile(snippetPath, "utf8")).trim();
  const gitignorePath = path.join(targetDir, ".gitignore");

  if (!(await pathExists(gitignorePath))) {
    await writeFile(gitignorePath, `${snippet}\n`);
    return true;
  }

  const existing = await readFile(gitignorePath, "utf8");
  if (existing.includes(".harness/runs/") && existing.includes(".harness/runtime/")) {
    return false;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(gitignorePath, `${existing}${separator}${snippet}\n`);
  return true;
}

async function ensureHarnessPackageScript(targetDir: string): Promise<boolean> {
  const packageJsonPath = path.join(targetDir, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return false;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }

  const scripts =
    parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
      ? ({ ...(parsed.scripts as Record<string, unknown>) } as Record<string, string>)
      : {};

  let changed = false;
  if (!scripts["harness:run"]) {
    scripts["harness:run"] = "hedera-harness run .harness/spec.yaml";
    changed = true;
  }
  // Keep legacy alias pointing at the new command for templates that still document extend.
  if (!scripts["harness:extend"]) {
    scripts["harness:extend"] = "hedera-harness run .harness/spec.yaml";
    changed = true;
  }

  if (!changed) {
    return false;
  }

  parsed.scripts = scripts;
  await writeFile(packageJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return true;
}

/** Test helper: ensure skeleton files exist in the package. */
export async function listProjectHarnessSkeletonFiles(): Promise<string[]> {
  const root = resolveProjectHarnessSkeletonRoot();
  const files: string[] = [];
  async function walk(dir: string, prefix = ""): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  await walk(root);
  return files.sort();
}
