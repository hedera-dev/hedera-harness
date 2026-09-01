/**
 * Operational knobs from the environment (timeouts, models, skills source).
 * Not recipe fields — editing a recipe to shorten a timeout would be a spurious
 * project diff. Precedence: CLI flag > environment > recipe > harness default.
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

export function envMaxAttempts(): number | undefined {
  return readPositiveInt("HARNESS_MAX_ATTEMPTS");
}

export function envAgentTimeoutMs(): number | undefined {
  const seconds = readPositiveInt("HARNESS_AGENT_TIMEOUT_S");
  return seconds === undefined ? undefined : seconds * 1_000;
}

export function envModel(): string | undefined {
  return readString("HARNESS_MODEL");
}

export function envRepairModel(): string | undefined {
  return readString("HARNESS_FIX_MODEL");
}

export function envDisableModelEscalation(): boolean {
  return readString("HARNESS_NO_MODEL_SWITCH") === "1";
}

export function envSkillsRepo(): string | undefined {
  return readString("HARNESS_SKILLS_REPO");
}

export function envSkillsRef(): string | undefined {
  return readString("HARNESS_SKILLS_REF");
}
