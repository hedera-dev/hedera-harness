import path from "node:path";
import { logPhase } from "./attemptLoop.js";
import { provisionHarnessProject } from "./harnessProvisioner.js";
import {
  DEFAULT_SCAFFOLD_REF,
  DEFAULT_SCAFFOLD_REPO,
  detectInitMode,
  resolveTemplateRef,
  seedProjectForInit,
} from "./initSeeder.js";
import { resolveHeadSha } from "./harnessGit.js";
import { resolveSkillsIndex } from "./skillProvider.js";
import type { InitCliOptions, InitResult } from "./types.js";

export interface RunInitOptions extends InitCliOptions {
  /** Test seam: skip yarn install after clone. */
  skipInstall?: boolean;
  /** Test seam: skip skill vendoring even when skill names are requested. */
  skipSkills?: boolean;
}

/**
 * Bootstrap a harness project, or adopt one that already exists.
 *
 * Two entry points converge here. A new or empty target is cloned from
 * scaffold-hbar and provisioned; a directory that already holds a project is
 * provisioned in place, which is how the harness is added to an app scaffolded
 * through create-hbar or to any existing repo.
 */
export async function runInit(options: RunInitOptions = {}): Promise<InitResult> {
  const targetDir = path.resolve(options.targetDir ?? process.cwd());
  const repo = options.repo?.trim() || DEFAULT_SCAFFOLD_REPO;
  const ref = options.ref?.trim()
    || (options.template?.trim() ? resolveTemplateRef(options.template) : undefined)
    || DEFAULT_SCAFFOLD_REF;

  const mode = await detectInitMode(targetDir);
  const inPlace = mode.kind === "in-place";

  logPhase(inPlace ? "Adopting harness in existing project" : "Init started", targetDir);

  const seeded = inPlace
    ? {
        targetDir,
        repo: undefined,
        ref: undefined,
        commitSha: await headShaOrUndefined(targetDir),
      }
    : await seedProjectForInit({
        targetDir,
        repo,
        ref,
        skipInstall: options.skipInstall === true,
      });

  let skillNames: string[] = [];
  if (!options.skipSkills) {
    skillNames =
      options.provisionSkills && options.provisionSkills.length > 0
        ? options.provisionSkills
        : (await resolveSkillsIndex(seeded.targetDir)).names;
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

  // Adopting a scaffold-hbar template finds a recipe already present. Say so,
  // rather than reporting "0 files written" and leaving the user to wonder.
  if (provisioned.skippedFiles.length > 0) {
    logPhase(
      "Kept existing recipe files",
      `${provisioned.skippedFiles.join(", ")} (not overwritten)`,
    );
  }

  logPhase(
    "Init complete",
    `${provisioned.writtenFiles.length} recipe file(s), ${provisioned.vendoredSkillFiles.length} skill file(s)`,
  );

  return {
    mode: inPlace ? "in-place" : "seeded",
    targetDir: seeded.targetDir,
    repo: seeded.repo,
    ref: seeded.ref,
    commitSha: seeded.commitSha,
    harnessDir: provisioned.harnessDir,
    writtenFiles: provisioned.writtenFiles,
    skippedFiles: provisioned.skippedFiles,
    vendoredSkillCount: provisioned.vendoredSkillFiles.length,
    gitignoreUpdated: provisioned.gitignoreUpdated,
    packageJsonUpdated: provisioned.packageJsonUpdated,
    nextSteps: buildNextSteps({
      targetDir: seeded.targetDir,
      inPlace,
      hadExistingRecipe: provisioned.skippedFiles.some(file => file.endsWith("spec.yaml")),
      packageJsonUpdated: provisioned.packageJsonUpdated,
    }),
  };
}

async function headShaOrUndefined(cwd: string): Promise<string | undefined> {
  try {
    return await resolveHeadSha(cwd);
  } catch {
    // Not a git repo yet, or no commits. `run` reports that with its own guidance.
    return undefined;
  }
}

function buildNextSteps(input: {
  targetDir: string;
  inPlace: boolean;
  hadExistingRecipe: boolean;
  packageJsonUpdated: boolean;
}): string[] {
  const steps: string[] = [];

  if (!input.inPlace) {
    steps.push(`cd ${input.targetDir}`);
    steps.push("Optional: add your own remote (init created a fresh git repo with no origin):");
    steps.push("  git remote add origin <your-repo-url>");
    steps.push("  git push -u origin main");
  }

  steps.push(
    input.hadExistingRecipe
      ? "This project already had a .harness/ recipe — it was left untouched."
      : "A starter recipe is under .harness/ — customize it before running:",
  );

  if (!input.hadExistingRecipe) {
    steps.push("Install the hedera-harness plugin from the marketplace to author it:");
    steps.push("  /plugin marketplace add hedera-dev/hedera-skills");
    steps.push("  /plugin install hedera-harness");
    steps.push("  /create-harness-spec — turn an idea into .harness/prd.md + spec + validators");
    steps.push("Or edit .harness/prd.md and .harness/spec.yaml by hand");
  }

  steps.push("hedera-harness doctor    # check the setup before a long run");
  steps.push(input.packageJsonUpdated ? "yarn harness:run" : "hedera-harness run");
  return steps;
}
