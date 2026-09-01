/**
 * Operational knobs read from the environment.
 *
 * These are the things you change while debugging a run — a timeout, an attempt
 * budget, a model — and they do not belong in the recipe. A recipe describes the
 * feature; editing it to shorten a timeout produces a spurious diff in the
 * project, and on a template branch it would be committed by mistake.
 *
 * Precedence everywhere: CLI flag > environment > recipe > harness default.
 */

function readPositiveInt(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(
      `[hedera-harness] ignoring ${name}=${JSON.stringify(raw)} — expected a positive integer.`,
    );
    return undefined;
  }
  return value;
}

function readString(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** Repair attempts per run, before the loop gives up. */
export function envMaxAttempts(): number | undefined {
  return readPositiveInt("HARNESS_MAX_ATTEMPTS");
}

/** Wall-clock budget for a single agent invocation. */
export function envAgentTimeoutMs(): number | undefined {
  const seconds = readPositiveInt("HARNESS_AGENT_TIMEOUT_S");
  return seconds === undefined ? undefined : seconds * 1_000;
}

/** Model for the first attempt of a cycle. */
export function envModel(): string | undefined {
  return readString("HARNESS_MODEL");
}

/** Model for repair attempts. */
export function envRepairModel(): string | undefined {
  return readString("HARNESS_FIX_MODEL");
}

/** Set to disable dropping to a cheaper model on repair attempts. */
export function envDisableModelEscalation(): boolean {
  return readString("HARNESS_NO_MODEL_SWITCH") === "1";
}

/** Skills git remote. Default is hedera-dev/hedera-skills. */
export function envSkillsRepo(): string | undefined {
  return readString("HARNESS_SKILLS_REPO");
}

/** Skills git ref. Default is master. */
export function envSkillsRef(): string | undefined {
  return readString("HARNESS_SKILLS_REF");
}
