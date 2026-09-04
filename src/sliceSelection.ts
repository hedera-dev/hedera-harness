import type { TemplateSpec } from "./types.js";

/** Paths for one increment in an ordered `prd:` list (and optional paired `eval:`). */
export interface ActiveSlicePaths {
  index: number;
  count: number;
  prdPath: string;
  evalPath?: string;
}

/** True when the recipe configures at least one evaluate checklist. */
export function specHasEval(spec: Pick<TemplateSpec, "evalPaths">): boolean {
  return Boolean(spec.evalPaths?.length);
}

/** Absolute eval paths to check in preflight (empty when EVALUATE is not configured). */
export function allEvalPaths(spec: Pick<TemplateSpec, "evalPaths">): string[] {
  return spec.evalPaths ?? [];
}

/**
 * Resolve the active PRD / eval pair for a slice index.
 *
 * - Scalar (`evalPaths` length 1): the same checklist for every index.
 * - List (`evalPaths` length === `prdPaths` length): `evalPaths[index]`.
 * - Absent `evalPaths`: `evalPath` is undefined.
 */
export function selectActiveSlice(
  spec: Pick<TemplateSpec, "prdPaths" | "evalPaths">,
  index: number,
): ActiveSlicePaths {
  const count = spec.prdPaths.length;
  if (index < 0 || index >= count) {
    throw new Error(`Slice index ${index} is out of range (0..${count - 1}).`);
  }

  const prdPath = spec.prdPaths[index]!;
  const evals = spec.evalPaths;
  let evalPath: string | undefined;
  if (evals && evals.length > 0) {
    evalPath = evals.length === 1 ? evals[0] : evals[index];
  }

  return { index, count, prdPath, evalPath };
}
