import type { CommandAgentConfig, SecretScanConfig } from "./types.js";

/**
 * Version of `.harness/spec.yaml` this harness writes.
 *
 * Bump only on breaking schema changes — a field removed, renamed, or given a
 * different meaning. Additive fields with safe defaults do not bump it.
 *
 * v1  original: required `generator`/`logging`, scalar `prd`, `extend.baseline`
 * v2  slim: `agent` preset, defaulted plumbing, `prd` list, `baseline`
 */
export const SPEC_SCHEMA_VERSION = 2;
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

/** Recipes predate the field; treat an absent version as the original schema. */
export const ASSUMED_SCHEMA_VERSION = 1;

export const DEFAULT_PRD_PATH = ".harness/prd.md";
export const DEFAULT_STATIC_VALIDATOR_PATH = ".harness/validators/static.json";
export const DEFAULT_COMMANDS_VALIDATOR_PATH = ".harness/validators/yarn.json";
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Harness-owned log locations.
 *
 * Not configurable. These live under `.harness/runs/`, which is the only tree
 * `filterRelevantDirtyEntries` ignores — pointing them elsewhere leaves untracked
 * files behind that fail the clean-tree check on the *next* run, so a user could
 * deadlock themselves by editing a field that looks cosmetic.
 */
export const HARNESS_JSONL_LOG_PATH = ".harness/runs/harness.log.jsonl";
export const HARNESS_NOTES_LOG_PATH = ".harness/runs/harness-notes.md";

export type AgentPresetName = "cursor" | "claude";

/**
 * How an agent CLI is told about MCP servers.
 *
 * `config-flag` keeps the project untouched — the harness writes its own file
 * and points the agent at it. `workspace-file` is for CLIs that only read a
 * fixed path, which means writing into the project and restoring afterwards.
 */
export type McpDelivery =
  | { kind: "config-flag"; flag: string }
  | { kind: "workspace-file"; path: string };

export interface AgentPreset extends CommandAgentConfig {
  mcp: McpDelivery;
  /**
   * Args for the read-only validator role.
   *
   * The generator invocation is the wrong shape for a validator: it grants
   * file-editing tools the validator must not have, and withholds the browser
   * tools it needs. Splitting them also enforces read-only at the permission
   * layer rather than only in the prompt.
   */
  validatorArgs?: string[];
  /** Flag that selects the model, so repair attempts can switch to a cheaper one. */
  modelFlag: string;
  /** Model for the first attempt of a cycle. */
  defaultModel: string;
  /** Model for repair attempts. Escalates back to `defaultModel` when stuck. */
  repairModel: string;
}

/**
 * Generator wiring per agent CLI.
 *
 * A preset name in the recipe means flag changes ship with the harness instead of
 * needing an edit in every project and template branch. `generator:` remains as an
 * escape hatch for anything these do not cover.
 */
export const AGENT_PRESETS: Record<AgentPresetName, AgentPreset> = {
  cursor: {
    provider: "command",
    command: "agent",
    args: [
      "-p",
      "--trust",
      "--sandbox",
      "enabled",
      "--workspace",
      "{workspace}",
      "--force",
      "--approve-mcps",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ],
    timeoutMs: 3_600_000,
    // The Cursor CLI has no flag to point at an MCP config; it reads the
    // workspace file, so the harness must write it and restore it afterwards.
    mcp: { kind: "workspace-file", path: ".cursor/mcp.json" },
    modelFlag: "--model",
    defaultModel: "composer-2.5",
    repairModel: "composer-2.5",
  },
  claude: {
    provider: "command",
    command: "claude",
    args: [
      "-p",
      "{prompt}",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Read,Edit,Write",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    timeoutMs: 3_600_000,
    // MCP tools must be named in --allowedTools: --permission-mode acceptEdits
    // auto-accepts edits only, so browser calls are otherwise permission-denied
    // in a non-interactive session even when the server is loaded.
    validatorArgs: [
      "-p",
      "{prompt}",
      "--allowedTools",
      "mcp__playwright,Read,Grep,Glob",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    mcp: { kind: "config-flag", flag: "--mcp-config" },
    modelFlag: "--model",
    defaultModel: "opus",
    repairModel: "sonnet",
  },
};

export const DEFAULT_AGENT_PRESET: AgentPresetName = "cursor";

export function isAgentPresetName(value: string): value is AgentPresetName {
  return Object.hasOwn(AGENT_PRESETS, value);
}

/** Secret-bearing files an app should never contain, given its workspaces. */
export function defaultSecretFiles(workspaces: string[] = []): string[] {
  return [".env", ...workspaces.map(workspace => `${workspace}/.env`)];
}

export const DEFAULT_SECRET_PATTERNS: SecretScanConfig["patterns"] = [
  {
    name: "private-key-assignment",
    pattern: "(PRIVATE_KEY|OPERATOR_KEY|HEDERA_OPERATOR_PRIVATE_KEY)\\s*=\\s*(0x)?[0-9a-fA-F]{32,}",
  },
];

const PACKAGE_MANAGERS = ["yarn", "npm", "pnpm"] as const;

/**
 * Everything that is not the project's package manager.
 *
 * Previously hand-listed in every recipe, which drifts the moment a template
 * switches managers.
 */
export function defaultForbiddenCommands(packageManager: string | undefined): string[] {
  const active = PACKAGE_MANAGERS.find(name => packageManager?.trim().toLowerCase().startsWith(name));
  return PACKAGE_MANAGERS.filter(name => name !== active).flatMap(name => [
    `${name} install`,
    `${name} run`,
  ]);
}

/** Top-level keys the loader understands. Anything else is surfaced as a warning. */
export const KNOWN_SPEC_KEYS = new Set([
  "schemaVersion",
  "name",
  "description",
  "prd",
  "contract",
  "agent",
  "generator",
  "validator",
  "skills",
  "constraints",
  "templateMetadata",
  "validators",
  "requiredFiles",
  "forbiddenFiles",
  "secretScan",
  "chainValidation",
  "baseline",
  "extend",
  "maxAttempts",
  "logging",
]);
