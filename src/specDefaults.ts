import type { ChainLocalConfig, CommandAgentConfig, SecretScanConfig } from "./types.js";

/**
 * `.harness/spec.yaml` schema this harness writes and accepts.
 * Bump only on breaking changes. Additive fields with safe defaults do not.
 * Older versions are not loaded.
 *
 * v1  original: required `generator`/`logging`, scalar `prd`, `extend.baseline`
 * v2  slim: `agent` preset, defaulted plumbing, `prd` list, `baseline`
 * v3  eval vocabulary: `contract` → `eval`, acceptance-contract.json → eval.json
 */
export const SPEC_SCHEMA_VERSION = 3;
export const MIN_SUPPORTED_SCHEMA_VERSION = SPEC_SCHEMA_VERSION;

export const DEFAULT_PRD_PATH = ".harness/prd.md";
export const DEFAULT_STATIC_VALIDATOR_PATH = ".harness/validators/static.json";
export const DEFAULT_COMMANDS_VALIDATOR_PATH = ".harness/validators/yarn.json";
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * `chainValidation.network: local` endpoints. These are hiero-local-node's
 * published ports, which hanvil also serves, so a recipe naming `local` needs
 * no URLs of its own.
 */
export const DEFAULT_LOCAL_CHAIN: ChainLocalConfig = {
  rpcUrl: "http://localhost:7546",
  grpcUrl: "localhost:50211",
  mirrorUrl: "http://localhost:5551",
};

/** Env var names a recipe inherits when it names no operator. */
export const DEFAULT_OPERATOR_ACCOUNT_ID_ENV = "HEDERA_OPERATOR_ID";
export const DEFAULT_OPERATOR_PRIVATE_KEY_ENV = "HEDERA_OPERATOR_KEY";

/** The single consensus node a local network runs. */
export const LOCAL_NODE_ACCOUNT_ID = "0.0.3";

/**
 * hiero-local-node's first predefined ECDSA account, used as the local operator
 * when the operator env vars are unset. These keys are published development
 * keys; they hold value on no real network.
 */
export const DEFAULT_LOCAL_OPERATOR = {
  accountId: "0.0.1002",
  privateKeyHex: "0x7f109a9e3b0d8ecfba9cc23a3614433ce0fa7ddcc80f2a8f10b222179a5a80d6",
};

/**
 * Not configurable. Logs live under `.harness/runs/` because that is the only
 * tree the dirty-check ignores — pointing them elsewhere deadlocks the next run.
 */
export const HARNESS_JSONL_LOG_PATH = ".harness/runs/harness.log.jsonl";
export const HARNESS_NOTES_LOG_PATH = ".harness/runs/harness-notes.md";

export type AgentPresetName = "cursor" | "claude";

/** `config-flag` writes a harness-owned file; `workspace-file` is for CLIs that only read a fixed path. */
export type McpDelivery =
  | { kind: "config-flag"; flag: string }
  | { kind: "workspace-file"; path: string };

export interface AgentPreset extends CommandAgentConfig {
  mcp: McpDelivery;
  /** Read-only validator invocation (no edit tools; includes browser tools). */
  validatorArgs?: string[];
  modelFlag: string;
  defaultModel: string;
  repairModel: string;
}

/** CLI wiring. Recipe `agent:` picks a preset so flag changes ship with the harness; `generator:` is the escape hatch. */
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
    // Cursor CLI has no --mcp-config flag. A probe on 2026.08.11-e8db854 showed
    // root `.mcp.json` alone is not enough; it loads `.cursor/mcp.json`, so the
    // harness writes that file and restores it afterwards.
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

export const DEFAULT_AGENT_PRESET: AgentPresetName = "claude";

export function isAgentPresetName(value: string): value is AgentPresetName {
  return Object.hasOwn(AGENT_PRESETS, value);
}

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

/** Every package manager except the project's, so recipes do not hand-list them. */
export function defaultForbiddenCommands(packageManager: string | undefined): string[] {
  const active = PACKAGE_MANAGERS.find(name => packageManager?.trim().toLowerCase().startsWith(name));
  return PACKAGE_MANAGERS.filter(name => name !== active).flatMap(name => [
    `${name} install`,
    `${name} run`,
  ]);
}

export const KNOWN_SPEC_KEYS = new Set([
  "schemaVersion",
  "name",
  "description",
  "prd",
  "eval",
  "agent",
  "generator",
  "validator",
  "constraints",
  "templateMetadata",
  "validators",
  "requiredFiles",
  "forbiddenFiles",
  "secretScan",
  "chainValidation",
  "baseline",
  "maxAttempts",
]);

/** Hard-fail at load. A silent drop would burn a generator session before EVALUATE. */
export const REMOVED_SPEC_KEYS: Readonly<Record<string, string>> = {
  contract: "use eval: not contract:",
  extend: "use baseline: not extend:",
  logging: "remove logging: — harness logs always live under .harness/runs/",
  skills: "remove skills: — product skills from hedera-skills are loaded automatically",
};
