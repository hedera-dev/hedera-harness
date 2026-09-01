/** Ignored session runtime for project-centric `run` (not committed). */
export const HARNESS_RUNTIME_DIR = ".harness/runtime";
export const HARNESS_SKILLS_DIR = `${HARNESS_RUNTIME_DIR}/skills`;
export const HARNESS_CONTEXT_DIR = `${HARNESS_RUNTIME_DIR}/context`;

/** Cached hedera-skills clone (gitignored). */
export const SKILL_CACHE_DIRNAME = ".skill-cache";

/**
 * Legacy isolated-workspace vendor dirs. `run` uses `.harness/runtime/`;
 * cleanup / git / secret-scan still skip these older layouts.
 */
export const ISOLATED_SKILLS_DIR = ".harness-skills";
export const ISOLATED_CONTEXT_DIR = ".harness-context";
