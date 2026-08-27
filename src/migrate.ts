import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument, type Document } from "yaml";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_PRESET,
  DEFAULT_COMMANDS_VALIDATOR_PATH,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRD_PATH,
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_STATIC_VALIDATOR_PATH,
  SPEC_SCHEMA_VERSION,
  defaultForbiddenCommands,
  defaultSecretFiles,
  type AgentPresetName,
} from "./specDefaults.js";

export interface MigrationChange {
  key: string;
  action: "removed" | "renamed" | "added";
  reason: string;
}

export interface MigrationResult {
  specPath: string;
  fromVersion: number;
  changed: boolean;
  changes: MigrationChange[];
  /** Things deliberately left alone, with why — the interesting half of the report. */
  kept: MigrationChange[];
  before: string;
  after: string;
  beforeLines: number;
  afterLines: number;
}

/**
 * Rewrite a v1/v2 recipe to current schema.
 *
 * The governing rule: **only remove a key whose value equals what the harness
 * would default it to.** A recipe that adds a forbidden command, an extra secret
 * pattern, or a non-standard validator path is expressing intent, and dropping it
 * would silently weaken the recipe while appearing to be a tidy-up. Anything that
 * differs is kept and reported, so the diff is reviewable rather than trusted.
 *
 * Comments and formatting on surviving keys are preserved by editing the parsed
 * document rather than re-emitting it.
 */
export async function migrateSpecFile(
  specPath: string,
  options: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const absolute = path.resolve(specPath);
  const before = await readFile(absolute, "utf8");
  const doc = parseDocument(before);
  const raw = doc.toJS() as Record<string, unknown>;

  const changes: MigrationChange[] = [];
  const kept: MigrationChange[] = [];
  const fromVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1;

  if (fromVersion >= SPEC_SCHEMA_VERSION) {
    return {
      specPath: absolute,
      fromVersion,
      changed: false,
      changes: [],
      kept: [],
      before,
      after: before,
      beforeLines: countLines(before),
      afterLines: countLines(before),
    };
  }

  const workspaces = readStringArray(raw, ["constraints", "workspaces"]) ?? [];

  // v2 → v3: rename `contract` key → `eval`, rewrite acceptance-contract.json → eval.json in value.
  if (fromVersion < 3) {
    migrateContractToEval(doc, raw, changes);
  }

  migrateGenerator(doc, raw, changes, kept);
  renameExtendToBaseline(doc, changes, kept);

  dropIfDefault(doc, raw, ["prd"], DEFAULT_PRD_PATH, changes, kept, "defaults to .harness/prd.md");
  dropIfDefault(
    doc,
    raw,
    ["validators", "static"],
    DEFAULT_STATIC_VALIDATOR_PATH,
    changes,
    kept,
    "defaulted",
  );
  dropIfDefault(
    doc,
    raw,
    ["validators", "commands"],
    DEFAULT_COMMANDS_VALIDATOR_PATH,
    changes,
    kept,
    "defaulted",
  );
  dropIfDefault(doc, raw, ["maxAttempts"], DEFAULT_MAX_ATTEMPTS, changes, kept, "defaults to 3");
  dropIfDefault(
    doc,
    raw,
    ["forbiddenFiles"],
    defaultSecretFiles(workspaces),
    changes,
    kept,
    "matches the default .env set",
  );
  dropIfDefault(
    doc,
    raw,
    ["constraints", "forbiddenCommands"],
    defaultForbiddenCommands(readString(raw, ["constraints", "packageManager"])),
    changes,
    kept,
    "derived from the package manager",
  );
  dropIfDefault(
    doc,
    raw,
    ["secretScan"],
    { failOnFiles: defaultSecretFiles(workspaces), patterns: DEFAULT_SECRET_PATTERNS },
    changes,
    kept,
    "matches the default secret scan",
  );

  // `logging` is ignored at load time regardless, so keeping it only misleads.
  if (raw.logging !== undefined) {
    doc.delete("logging");
    changes.push({
      key: "logging",
      action: "removed",
      reason: "harness logs always live under .harness/runs/; the key is ignored",
    });
  }

  dropRecipeTautologies(doc, raw, changes);
  removeEmptyMap(doc, "validators");

  setSchemaVersionFirst(doc);
  changes.push({
    key: "schemaVersion",
    action: "added",
    reason: `pins the recipe at v${SPEC_SCHEMA_VERSION} (eval vocabulary)`,
  });

  const after = doc.toString({ lineWidth: 0 });
  if (!options.dryRun && after !== before) {
    await writeFile(absolute, after, "utf8");
  }

  return {
    specPath: absolute,
    fromVersion,
    changed: after !== before,
    changes,
    kept,
    before,
    after,
    beforeLines: countLines(before),
    afterLines: countLines(after),
  };
}

export function formatMigrationResult(result: MigrationResult, dryRun: boolean): string {
  if (!result.changed) {
    return `${result.specPath}\n  already schema v${result.fromVersion} — nothing to do.`;
  }

  const lines = [
    `${result.specPath}`,
    `  v${result.fromVersion} → v${SPEC_SCHEMA_VERSION}  ${result.beforeLines} → ${result.afterLines} lines`,
    "",
  ];

  for (const change of result.changes) {
    const verb = change.action === "removed" ? "-" : change.action === "added" ? "+" : "~";
    lines.push(`  ${verb} ${change.key} — ${change.reason}`);
  }

  if (result.kept.length > 0) {
    lines.push("", "  kept (differs from the default):");
    for (const change of result.kept) {
      lines.push(`    · ${change.key} — ${change.reason}`);
    }
  }

  lines.push("", dryRun ? "  (dry run — nothing written)" : "  written.");
  return lines.join("\n");
}

/**
 * v2 → v3: rename the `contract` key to `eval` and rewrite
 * `acceptance-contract.json` → `eval.json` in the path value.
 *
 * Does NOT mass-rewrite assertion IDs inside JSON bodies — only the recipe key
 * and path filename. The file on disk is also renamed when not a dry run.
 */
function migrateContractToEval(
  doc: Document,
  raw: Record<string, unknown>,
  changes: MigrationChange[],
): void {
  const contractValue = raw.contract;
  if (contractValue === undefined) return;

  const newValue =
    typeof contractValue === "string"
      ? contractValue.replace(/acceptance-contract\.json$/i, "eval.json")
      : contractValue;

  doc.delete("contract");
  doc.set("eval", newValue);
  changes.push({
    key: "contract → eval",
    action: "renamed",
    reason: "v3 vocab: `contract` key becomes `eval`, acceptance-contract.json → eval.json",
  });
}

/**
 * Replace a recognisable preset invocation with `agent:`.
 *
 * Only when the recipe's flags are a subset of the preset's and the model matches
 * its default — otherwise the block is expressing something the preset does not,
 * and is kept verbatim.
 */
function migrateGenerator(
  doc: Document,
  raw: Record<string, unknown>,
  changes: MigrationChange[],
  kept: MigrationChange[],
): void {
  const generator = raw.generator as { command?: string; args?: string[] } | undefined;
  if (!generator?.command) return;

  const presetName = (Object.keys(AGENT_PRESETS) as AgentPresetName[]).find(
    name => AGENT_PRESETS[name].command === generator.command,
  );
  if (!presetName) {
    kept.push({
      key: "generator",
      action: "removed",
      reason: `command ${JSON.stringify(generator.command)} is not a known preset`,
    });
    return;
  }

  const preset = AGENT_PRESETS[presetName];
  const presetFlags = new Set((preset.args ?? []).filter(isFlag));
  const recipeFlags = (generator.args ?? []).filter(isFlag);
  const unknownFlags = recipeFlags.filter(flag => flag !== preset.modelFlag && !presetFlags.has(flag));

  if (unknownFlags.length > 0) {
    kept.push({
      key: "generator",
      action: "removed",
      reason: `carries flags the ${presetName} preset does not set: ${unknownFlags.join(", ")}`,
    });
    return;
  }

  const model = valueAfter(generator.args ?? [], preset.modelFlag);
  if (model && model !== preset.defaultModel) {
    kept.push({
      key: "generator",
      action: "removed",
      reason: `pins ${preset.modelFlag} ${model}, which differs from the ${presetName} default (${preset.defaultModel})`,
    });
    return;
  }

  doc.delete("generator");
  changes.push({
    key: "generator",
    action: "removed",
    reason: `replaced by the ${presetName} preset`,
  });

  if (presetName !== DEFAULT_AGENT_PRESET) {
    doc.set("agent", presetName);
    changes.push({ key: "agent", action: "added", reason: `selects the ${presetName} preset` });
  }
}

/** `extend.baseline` → top-level `baseline`, in place so surrounding comments survive. */
function renameExtendToBaseline(
  doc: Document,
  changes: MigrationChange[],
  kept: MigrationChange[],
): void {
  const baselineNode = doc.getIn(["extend", "baseline"], true);
  if (baselineNode === undefined) return;

  let carriedComment: string | undefined;

  type Pair = { key?: { value?: unknown; commentBefore?: string | null } };
  const contents = doc.contents as { items?: Pair[] } | null;
  const items = contents?.items;
  if (!items) return;

  const index = items.findIndex(item => item.key?.value === "extend");
  const pair = doc.createPair("baseline", baselineNode) as Pair;

  if (index >= 0) {
    // Comments sit on the key node, not the pair. The comment above `extend:`
    // documents the baseline rather than the old key name, so it moves with it —
    // but it may reference keys this migration removed, hence the review note.
    const carried = items[index].key?.commentBefore;
    if (carried && pair.key) {
      pair.key.commentBefore = carried;
      carriedComment = carried.trim();
    }
    items.splice(index, 1, pair);
  } else {
    items.push(pair);
  }

  changes.push({
    key: "extend.baseline → baseline",
    action: "renamed",
    reason: "`extend` named a command that no longer exists",
  });

  if (carriedComment) {
    kept.push({
      key: "comment above `baseline`",
      action: "renamed",
      reason: "carried from `extend` — re-read it, it may mention keys this migration removed",
    });
  }
}

/** Asserting the recipe's own files exist is circular — the loader just read them. */
function dropRecipeTautologies(
  doc: Document,
  raw: Record<string, unknown>,
  changes: MigrationChange[],
): void {
  const required = raw.requiredFiles;
  if (!Array.isArray(required)) return;

  const tautologies = new Set([".harness/spec.yaml", ".harness/prd.md"]);
  const remaining = required.filter(entry => !tautologies.has(String(entry)));
  if (remaining.length === required.length) return;

  doc.set("requiredFiles", remaining);
  changes.push({
    key: "requiredFiles",
    action: "removed",
    reason: `dropped ${required.length - remaining.length} self-referential entr(y/ies)`,
  });
}

function dropIfDefault(
  doc: Document,
  raw: Record<string, unknown>,
  keyPath: string[],
  defaultValue: unknown,
  changes: MigrationChange[],
  kept: MigrationChange[],
  reason: string,
): void {
  const current = keyPath.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
    raw,
  );
  if (current === undefined) return;

  const label = keyPath.join(".");
  if (JSON.stringify(current) === JSON.stringify(defaultValue)) {
    doc.deleteIn(keyPath);
    changes.push({ key: label, action: "removed", reason });
    return;
  }

  kept.push({ key: label, action: "removed", reason: "differs from the default" });
}

function removeEmptyMap(doc: Document, key: string): void {
  const value = doc.get(key) as { items?: unknown[] } | undefined;
  if (value && Array.isArray(value.items) && value.items.length === 0) {
    doc.delete(key);
  }
}

function setSchemaVersionFirst(doc: Document): void {
  doc.delete("schemaVersion");
  const contents = doc.contents as { items?: unknown[] } | null;
  const pair = doc.createPair("schemaVersion", SPEC_SCHEMA_VERSION);
  if (contents?.items) {
    contents.items.unshift(pair);
  }
}

function isFlag(value: string): boolean {
  return value.startsWith("-");
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readString(raw: Record<string, unknown>, keyPath: string[]): string | undefined {
  const value = keyPath.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
    raw,
  );
  return typeof value === "string" ? value : undefined;
}

function readStringArray(raw: Record<string, unknown>, keyPath: string[]): string[] | undefined {
  const value = keyPath.reduce<unknown>(
    (node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
    raw,
  );
  return Array.isArray(value) && value.every(item => typeof item === "string")
    ? (value as string[])
    : undefined;
}

function countLines(value: string): number {
  return value.split("\n").length;
}
