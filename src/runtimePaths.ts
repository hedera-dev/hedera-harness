/** Session-scoped runtime root for in-place extend (ignored; not committed). */
export const EXTEND_RUNTIME_DIR = ".harness/runtime";
export const EXTEND_SKILLS_DIR = `${EXTEND_RUNTIME_DIR}/skills`;
export const EXTEND_CONTEXT_DIR = `${EXTEND_RUNTIME_DIR}/context`;

/** Isolated `run` workspace vendor locations (existing behavior). */
export const ISOLATED_SKILLS_DIR = ".harness-skills";
export const ISOLATED_CONTEXT_DIR = ".harness-context";

export function extendPrdRelativePath(): string {
  return `${EXTEND_CONTEXT_DIR}/prd.md`;
}

export function extendContractRelativePath(): string {
  return `${EXTEND_CONTEXT_DIR}/acceptance-contract.json`;
}
