import path from "node:path";
import { logPhase } from "./attemptLoop.js";
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

  logPhase("Init started", targetDir);

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

  logPhase(
    "Provisioning .harness/",
    skillNames.length > 0 ? `skills=${skillNames.join(",")}` : "skills=none",
  );

  const provisioned = await provisionHarnessProject({
    targetDir: seeded.targetDir,
    skillNames,
    copySkillsIndex: true,
  });

  logPhase(
    "Init complete",
    `${provisioned.writtenFiles.length} recipe file(s), ${provisioned.vendoredSkillFiles.length} skill file(s)`,
  );

  const nextSteps = [
    `cd ${seeded.targetDir}`,
    "A starter recipe is already under .harness/ — customize it before run:",
    "Optional: add your own remote (init created a fresh git repo with no origin):",
    "  git remote add origin <your-repo-url>",
    "  git push -u origin main",
    "Install the hedera-harness plugin from the marketplace, then author the recipe (recommended):",
    "  /plugin marketplace add hedera-dev/hedera-skills",
    "  /plugin install hedera-harness",
    "  /create-harness-spec — turn a demo idea into .harness/prd.md + spec + validators",
    "  /review-harness-spec — audit the recipe before you run",
    "Or edit .harness/prd.md and .harness/spec.yaml by hand",
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
