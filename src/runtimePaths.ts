/** Session-scoped runtime root for project-centric `run` (ignored; not committed). */
export const HARNESS_RUNTIME_DIR = ".harness/runtime";
export const HARNESS_SKILLS_DIR = `${HARNESS_RUNTIME_DIR}/skills`;
export const HARNESS_CONTEXT_DIR = `${HARNESS_RUNTIME_DIR}/context`;

/**
 * Legacy isolated-workspace vendor locations (kept for validate-semantic refresh
 * and older layouts; project-centric `run` uses `.harness/runtime/`).
 */
export const ISOLATED_SKILLS_DIR = ".harness-skills";
export const ISOLATED_CONTEXT_DIR = ".harness-context";

export function harnessPrdRelativePath(): string {
  return `${HARNESS_CONTEXT_DIR}/prd.md`;
}

export function harnessEvalRelativePath(): string {
  return `${HARNESS_CONTEXT_DIR}/eval.json`;
}
