import { REMOVED_SPEC_KEYS } from "./specDefaults.js";

/**
 * The recipe shape, for unknown-key reporting only.
 *
 * The readers in specLoader.ts pull named keys out of each block and ignore the
 * rest, so a misspelled key inside a block is not a load error — the block just
 * silently falls back to its default. `chainValidation.enable: false` leaves
 * CHAIN on, `fundingHBAR: 50` funds 10, and the failure shows up an hour later
 * as "insufficient payer balance" with nothing pointing at the recipe.
 *
 * This map is the one place that has to grow when a block gains a key. A test
 * pins its top level to KNOWN_SPEC_KEYS so a new top-level key cannot be added
 * without also being registered here.
 */
export type SpecField =
  /** Value is not inspected — scalars, string lists, and leaf arrays. */
  | "value"
  /** Object with caller-defined keys (env vars, template metadata). Not walked. */
  | "freeform"
  | { object: SpecShape }
  /** Array of objects sharing one shape. Non-object items are skipped. */
  | { arrayOf: SpecShape };

export interface SpecShape {
  [key: string]: SpecField;
}

const COMMAND_SHAPE: SpecShape = {
  name: "value",
  command: "value",
  timeoutMs: "value",
};

const AGENT_INVOCATION_SHAPE: SpecShape = {
  // Accepted and ignored: there is one provider, but recipes and template
  // branches write it, so reporting it would be noise on working recipes.
  provider: "value",
  command: "value",
  args: "value",
  env: "freeform",
  timeoutMs: "value",
};

export const SPEC_SHAPE: SpecShape = {
  schemaVersion: "value",
  name: "value",
  description: "value",
  prd: "value",
  eval: "value",
  agent: "value",
  maxAttempts: "value",
  requiredFiles: "value",
  forbiddenFiles: "value",
  generator: { object: AGENT_INVOCATION_SHAPE },
  validator: { object: { ...AGENT_INVOCATION_SHAPE, enabled: "value" } },
  constraints: {
    object: {
      packageManager: "value",
      workspaces: "value",
      forbiddenWorkspaces: "value",
      forbiddenCommands: "value",
    },
  },
  // Template branches carry their own descriptive fields here and the harness
  // reads three of them, so unknown keys are expected rather than suspicious.
  templateMetadata: "freeform",
  validators: {
    object: {
      static: "value",
      commands: "value",
      playwright: "value",
    },
  },
  secretScan: {
    object: {
      failOnFiles: "value",
      patterns: { arrayOf: { name: "value", pattern: "value", allowIn: "value" } },
    },
  },
  chainValidation: {
    object: {
      enabled: "value",
      network: "value",
      fundingHbar: "value",
      sweepBack: "value",
      operator: { object: { accountIdEnv: "value", privateKeyEnv: "value" } },
      expose: { object: { browserLocalStorageKey: "value", envVars: "value" } },
      deploy: { object: { commands: { arrayOf: COMMAND_SHAPE } } },
    },
  },
  baseline: { object: { commands: { arrayOf: COMMAND_SHAPE } } },
};

export interface UnknownSpecKey {
  /** Dotted path as written in the recipe, e.g. `chainValidation.expose.envVar`. */
  path: string;
  /** Nearest registered key at that level, when one is close enough to name. */
  suggestion?: string;
}

/**
 * Every key the loader would ignore, deepest-first within each block.
 *
 * Removed keys are skipped here: rejectRemovedKeys() already fails the load
 * with the migration sentence, and repeating them as "unknown" would suggest
 * the wrong fix.
 */
export function collectUnknownSpecKeys(parsed: Record<string, unknown>): UnknownSpecKey[] {
  const found: UnknownSpecKey[] = [];
  walk(parsed, SPEC_SHAPE, "", found);
  return found;
}

function walk(
  value: Record<string, unknown>,
  shape: SpecShape,
  prefix: string,
  found: UnknownSpecKey[],
): void {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const field = Object.hasOwn(shape, key) ? shape[key] : undefined;

    if (field === undefined) {
      if (prefix === "" && key in REMOVED_SPEC_KEYS) continue;
      found.push(withSuggestion(path, key, shape));
      continue;
    }

    if (field === "value" || field === "freeform") continue;

    if ("object" in field) {
      if (isPlainObject(child)) walk(child, field.object, path, found);
      continue;
    }

    if (!Array.isArray(child)) continue;
    child.forEach((item, index) => {
      if (isPlainObject(item)) walk(item, field.arrayOf, `${path}[${index}]`, found);
    });
  }
}

function withSuggestion(path: string, key: string, shape: SpecShape): UnknownSpecKey {
  const suggestion = suggestKey(key, Object.keys(shape));
  return suggestion ? { path, suggestion } : { path };
}

/**
 * Nearest registered key, or undefined when nothing is close.
 *
 * Case-only misses (`timeoutMS`, `fundingHBAR`, `packagemanager`) are the common
 * hand-written mistake and edit distance rates them as badly as an unrelated
 * word, so they are matched first and exactly.
 */
export function suggestKey(unknown: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates];
  const lowered = unknown.toLowerCase();

  const sameLetters = list.find(candidate => candidate.toLowerCase() === lowered);
  if (sameLetters) return sameLetters;

  let best: { key: string; distance: number } | undefined;
  for (const candidate of list) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (!best || distance < best.distance) best = { key: candidate, distance };
  }

  if (!best) return undefined;
  // One edit is always worth naming; a second only on keys long enough that two
  // edits still leave an obvious relation ("comand" -> "commands", not "a" -> "eval").
  const limit = Math.min(2, Math.max(1, Math.floor(unknown.length / 4)));
  return best.distance <= limit ? best.key : undefined;
}

/** Levenshtein distance, two rows rather than a full matrix. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

/**
 * One line per key, so a recipe with three typos reports three of them.
 *
 * A key with no near match is more likely to come from a newer recipe than to
 * be a typo, so it keeps the original upgrade hint instead of a guess.
 */
export function formatUnknownSpecKeys(unknown: UnknownSpecKey[]): string[] {
  return unknown.map(entry =>
    entry.suggestion
      ? `ignoring unknown key "${entry.path}" — did you mean "${entry.suggestion}"?`
      : `ignoring unknown key "${entry.path}". If it comes from a newer recipe, upgrade the harness.`,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
