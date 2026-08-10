import path from "node:path";
import { listRegisteredSkillNames, provisionHarnessProject } from "./harnessProvisioner.js";
import { DEFAULT_SCAFFOLD_REF, DEFAULT_SCAFFOLD_REPO, seedProjectForInit } from "./initSeeder.js";
import type { InitCliOptions, InitResult } from "./types.js";

export interface RunInitOptions extends InitCliOptions {
  /** Test seam: skip yarn install after clone. */
  skipInstall?: boolean;
  /** Test seam: skip skill vendoring even when skill names are requested. */
  skipSkills?: boolean;
}

/**
 * Bootstrap a project-centric harness workspace:
 * 1. Clone scaffold-hbar (keep `.git`)
 * 2. Provision `.harness/` recipe + skills index
 * 3. Optionally pre-vendor hedera skills
 */
export async function runInit(options: RunInitOptions = {}): Promise<InitResult> {
  const targetDir = path.resolve(options.targetDir ?? process.cwd());
  const repo = options.repo?.trim() || DEFAULT_SCAFFOLD_REPO;
  const ref = options.ref?.trim() || options.template?.trim() || DEFAULT_SCAFFOLD_REF;
  const skipInstall = options.skipInstall === true;

  const seeded = await seedProjectForInit({
    targetDir,
    repo,
    ref,
    skipInstall,
  });

  let skillNames: string[] = [];
  if (!options.skipSkills) {
    if (options.provisionSkills && options.provisionSkills.length > 0) {
      skillNames = options.provisionSkills;
    } else {
      // Default: provision all registered skills so the project is self-contained.
      skillNames = await listRegisteredSkillNames(seeded.targetDir);
    }
  }

  const provisioned = await provisionHarnessProject({
    targetDir: seeded.targetDir,
    skillNames,
    copySkillsIndex: true,
  });

  const nextSteps = [
    `cd ${seeded.targetDir}`,
    "Edit .harness/prd.md and .harness/spec.yaml for your feature",
    "hedera-harness run .harness/spec.yaml",
    // yarn script if package.json was updated
    provisioned.packageJsonUpdated ? "or: yarn harness:run" : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    targetDir: seeded.targetDir,
    repo: seeded.repo,
    ref: seeded.ref,
    commitSha: seeded.commitSha,
    harnessDir: provisioned.harnessDir,
    writtenFiles: provisioned.writtenFiles,
    vendoredSkillCount: provisioned.vendoredSkillFiles.length,
    gitignoreUpdated: provisioned.gitignoreUpdated,
    packageJsonUpdated: provisioned.packageJsonUpdated,
    nextSteps,
  };
}
