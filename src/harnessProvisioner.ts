import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logPhase } from "./attemptLoop.js";
import { pathExists } from "./fsUtils.js";
import { PROJECT_SKILLS_DIR } from "./runtimePaths.js";
import { provideSkills, resolveSkillsIndex } from "./skillProvider.js";

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
  /** Recipe files already present and deliberately left alone. */
  skippedFiles: string[];
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
  const skippedFiles: string[] = [];

  await mkdir(path.join(harnessDir, "validators"), { recursive: true });
  await mkdir(path.join(harnessDir, "runs"), { recursive: true });

  const copies: Array<[string, string]> = [
    ["spec.yaml", path.join(harnessDir, "spec.yaml")],
    ["prd.md", path.join(harnessDir, "prd.md")],
    ["validators/static.json", path.join(harnessDir, "validators", "static.json")],
    ["validators/yarn.json", path.join(harnessDir, "validators", "yarn.json")],
  ];

  for (const [relative, dest] of copies) {
    // Never overwrite: a scaffold-hbar template ships its own recipe, and
    // clobbering it would discard the template author's work.
    if (await pathExists(dest)) {
      skippedFiles.push(path.relative(targetDir, dest));
      continue;
    }
    await copyFile(path.join(skeletonRoot, relative), dest);
    writtenFiles.push(path.relative(targetDir, dest));
  }

  if (input.copySkillsIndex !== false) {
    const index = await resolveSkillsIndex(targetDir);
    if (!(await pathExists(index.localPath))) {
      await copyFile(index.sourcePath, index.localPath);
      writtenFiles.push(path.relative(targetDir, index.localPath));
    }
  }

  let vendoredSkillFiles: string[] = [];
  const skillNames = input.skillNames ?? [];
  if (skillNames.length > 0) {
    logPhase("Resolving and vendoring skills", `${skillNames.length} name(s)`);
    const vendored = await provideSkills({
      skillRefs: skillNames,
      projectRoot: targetDir,
      workspacePath: targetDir,
      skillsDir: PROJECT_SKILLS_DIR,
    });
    vendoredSkillFiles = vendored.map(entry => entry.relativePath);
    logPhase("Skills vendored", `${vendoredSkillFiles.length} file(s)`);
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
    skippedFiles,
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

  if (scripts["harness:run"]) {
    return false;
  }

  scripts["harness:run"] = "hedera-harness run .harness/spec.yaml";

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
