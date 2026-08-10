/** Session-scoped runtime root for project-centric `run` (ignored; not committed). */
export const EXTEND_RUNTIME_DIR = ".harness/runtime";
export const EXTEND_SKILLS_DIR = `${EXTEND_RUNTIME_DIR}/skills`;
export const EXTEND_CONTEXT_DIR = `${EXTEND_RUNTIME_DIR}/context`;

/** Aliases matching the project-centric naming. */
export const RUN_RUNTIME_DIR = EXTEND_RUNTIME_DIR;
export const RUN_SKILLS_DIR = EXTEND_SKILLS_DIR;
export const RUN_CONTEXT_DIR = EXTEND_CONTEXT_DIR;

/**
 * Legacy isolated-workspace vendor locations (kept for validate-semantic refresh
 * and older layouts; project-centric `run` uses `.harness/runtime/`).
 */
export const ISOLATED_SKILLS_DIR = ".harness-skills";
export const ISOLATED_CONTEXT_DIR = ".harness-context";

export function extendPrdRelativePath(): string {
  return `${EXTEND_CONTEXT_DIR}/prd.md`;
}

export function extendContractRelativePath(): string {
  return `${EXTEND_CONTEXT_DIR}/acceptance-contract.json`;
}
