import type { AgentProgress } from "./agentStreamLogger.js";

export type HarnessCommand = "run" | "validate" | "validate-semantic";

export interface CommandExecutionResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  skipped?: boolean;
  skipReason?: string;
}

export interface CliOptions {
  specPath: string;
  maxAttempts?: number;
  workspacePath?: string;
  /** Reuse an existing run directory's workspace (accumulating project). */
  continueRunDirectory?: string;
}

export interface ParsedCli {
  command: HarnessCommand;
  options: CliOptions;
}

export interface AgentRunInput {
  workspacePath: string;
  prompt: string;
  attempt: number;
  role?: "generator" | "validator";
  timeoutMs?: number;
  logPath?: string;
  activityLogPath?: string;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
}

export interface AgentRunResult extends CommandExecutionResult {
  command: string;
  args: string[];
}

export interface AgentProvider {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export interface CommandAgentConfig {
  provider: "command";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type AgentConfig = CommandAgentConfig;

export interface PreflightCommandConfig {
  name?: string;
  command: string;
  timeoutMs?: number;
}

export interface SeedConfig {
  repo: string;
  ref: string;
  mode?: "clone-ref-to-run-workspace" | "copy-local-ref";
  workspace?: string;
  preflight?: {
    commands?: Array<string | PreflightCommandConfig>;
  };
  isolation?: {
    separateFolder?: boolean;
    neverModifySeedRepo?: boolean;
    excludeFromArtifact?: string[];
  };
}

export interface WorkspaceSeedInput {
  seed: SeedConfig;
  runDirectory: string;
  workspacePath?: string;
  fetchLatest?: boolean;
  runPreflight?: boolean;
}

export interface WorkspaceSeedResult {
  workspacePath: string;
  repo: string;
  ref: string;
  commitSha: string;
  fetchedLatest: boolean;
  preflight: CommandExecutionResult[];
}

export interface TemplateConstraints {
  packageManager?: string;
  workspaces?: string[];
  forbiddenWorkspaces?: string[];
  forbiddenCommands?: string[];
}

export interface TemplateMetadata {
  name?: string;
  frontend?: string;
  solidityFramework?: string;
}

export interface SecretScanConfig {
  failOnFiles: string[];
  patterns: Array<{
    name: string;
    pattern: string;
    allowIn?: string[];
  }>;
}

export interface ValidatorAgentConfig extends CommandAgentConfig {
  enabled?: boolean;
}

export interface ChainValidationOperatorConfig {
  accountIdEnv: string;
  privateKeyEnv: string;
}

export interface ChainValidationExposeConfig {
  /** localStorage key for burner-connector (default: burnerWallet.pk). */
  browserLocalStorageKey?: string;
  /** Env var names that receive the ephemeral private key for deploy commands. */
  envVars?: string[];
}

export interface ChainValidationDeployCommand {
  name: string;
  command: string;
  timeoutMs?: number;
}

export interface ChainValidationDeployConfig {
  commands: ChainValidationDeployCommand[];
}

/**
 * Optional Tier 3.5 on-chain validation: provision an ephemeral funded ECDSA
 * testnet account, inject it as a burner wallet, and verify txs via mirror node.
 */
export interface ChainValidationConfig {
  enabled: boolean;
  network: "testnet";
  operator: ChainValidationOperatorConfig;
  fundingHbar: number;
  sweepBack: boolean;
  expose: ChainValidationExposeConfig;
  deploy?: ChainValidationDeployConfig;
}

/** Ephemeral ECDSA test signer provisioned for a harness run. */
export interface ChainSigner {
  accountId: string;
  privateKeyHex: string;
  evmAddress: string;
  network: "testnet";
}

export interface ExtendBaselineCommandConfig {
  name?: string;
  command: string;
  timeoutMs?: number;
}

export interface ExtendBaselineConfig {
  /** Non-target health checks run once after branch creation (before generation). */
  commands?: ExtendBaselineCommandConfig[];
}

/** In-place `extend` options (ignored by isolated `run`). */
export interface ExtendConfig {
  baseline?: ExtendBaselineConfig;
}

export interface TemplateSpec {
  name: string;
  description?: string;
  prdPath: string;
  contractPath?: string;
  seed: SeedConfig;
  generator: CommandAgentConfig;
  validator?: ValidatorAgentConfig;
  skills?: string[];
  constraints?: TemplateConstraints;
  templateMetadata?: TemplateMetadata;
  validators: {
    staticPath: string;
    commandsPath: string;
    playwrightPath?: string;
  };
  requiredFiles: string[];
  forbiddenFiles: string[];
  secretScan?: SecretScanConfig;
  chainValidation?: ChainValidationConfig;
  /** Optional in-place extension configuration. */
  extend?: ExtendConfig;
  maxAttempts: number;
  logging: {
    jsonlPath: string;
    notesPath: string;
  };
}

export interface PlaywrightGateRouteResult {
  name: string;
  path: string;
  statusCode: number | null;
  rendered: boolean;
  consoleErrors: string[];
  forbiddenTextFound: string[];
  durationMs: number;
}

export interface PlaywrightGateResult {
  passed: boolean;
  configPath: string;
  serverUrl: string;
  serverCommand: string;
  routes: PlaywrightGateRouteResult[];
  durationMs: number;
}

export interface ValidatorIssue {
  id: string;
  contractAssertion?: string;
  severity: "critical" | "major" | "minor";
  route?: string;
  message: string;
  evidence?: string;
}

export interface ValidatorVerdict {
  passed: boolean;
  summary: string;
  issues: ValidatorIssue[];
}

export interface SemanticValidationResult {
  passed: boolean;
  verdict?: ValidatorVerdict;
  findings: ValidationFinding[];
  serverUrl?: string;
  durationMs: number;
  /** True when failure is harness/agent tooling (MCP/browser), not the generated app. */
  infrastructureFailure?: boolean;
  infrastructureFailureReason?: string;
}

export interface ValidationFinding {
  id: string;
  category:
    | "files"
    | "static"
    | "secret"
    | "commands"
    | "agent"
    | "oracle"
    | "playwright"
    | "semantic"
    | "semantic-infra";
  message: string;
  details?: string;
  /** Acceptance-contract assertion id when category is semantic (e.g. C7). */
  contractAssertion?: string;
  /** Route associated with a semantic finding, when known. */
  route?: string;
}

export interface OracleAccessFinding {
  id: string;
  message: string;
  evidence: string;
  path?: string;
}

export interface BlindIntegrityResult {
  passed: boolean;
  findings: OracleAccessFinding[];
  scannedLogs: string[];
}

export interface ValidationResult {
  passed: boolean;
  findings: ValidationFinding[];
  commandResults: CommandExecutionResult[];
  playwrightGate?: PlaywrightGateResult;
  semanticValidation?: SemanticValidationResult;
}

export interface RunReport {
  specName: string;
  specPath: string;
  runDirectory: string;
  workspacePath: string;
  seedRepo: string;
  seedRef: string;
  seedCommitSha: string;
  attempts: number;
  maxAttempts: number;
  /** Set when this kick was a --continue cycle (1-based). */
  cycle?: number;
  /** Attempts consumed in this kick only (fresh maxAttempts budget). */
  attemptsThisCycle?: number;
  /** True when deterministic, playwright gate, and semantic validation (if configured) all pass. */
  passed: boolean;
  blindIntegrity: BlindIntegrityResult;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  validation: ValidationResult;
  semanticValidation?: SemanticValidationResult;
}

export type HarnessLogEvent =
  | {
      type: "run_started";
      timestamp: string;
      specName: string;
      runDirectory: string;
    }
  | {
      type: "run_continued";
      timestamp: string;
      specName: string;
      runDirectory: string;
      cycle: number;
      startingAttempt: number;
      maxAttemptsThisCycle: number;
    }
  | {
      type: "cycle_started";
      timestamp: string;
      cycle: number;
      startingAttempt: number;
      maxAttemptsThisCycle: number;
    }
  | {
      type: "continue_started";
      timestamp: string;
      attempt: number;
      cycle: number;
      promptPath: string;
    }
  | {
      type: "workspace_seeded";
      timestamp: string;
      seedCommitSha: string;
      workspacePath: string;
    }
  | {
      type: "skills_vendored";
      timestamp: string;
      count: number;
      workspaceSkillsDir: string;
    }
  | {
      type: "context_vendored";
      timestamp: string;
      prdPath: string;
      contractPath?: string;
      workspaceContextDir: string;
    }
  | {
      type: "chain_signer_provisioned";
      timestamp: string;
      accountId: string;
      evmAddress: string;
      network: "testnet";
      reused: boolean;
    }
  | {
      type: "chain_signer_swept";
      timestamp: string;
      accountId: string;
      success: boolean;
      error?: string;
    }
  | {
      type: "workspace_git_initialized";
      timestamp: string;
      commitSha: string;
    }
  | {
      type: "workspace_git_committed";
      timestamp: string;
      attempt: number;
      committed: boolean;
      commitSha?: string;
      message: string;
    }
  | {
      type: "generator_started";
      timestamp: string;
      attempt: number;
      promptPath: string;
    }
  | {
      type: "generator_finished";
      timestamp: string;
      attempt: number;
      exitCode: number | null;
      durationMs: number;
      timedOut: boolean;
    }
  | {
      type: "oracle_audit_finished";
      timestamp: string;
      attempt: number;
      passed: boolean;
      findingCount: number;
    }
  | {
      type: "validation_finished";
      timestamp: string;
      attempt: number;
      passed: boolean;
      findingCount: number;
    }
  | {
      type: "validator_started";
      timestamp: string;
      attempt: number;
      promptPath: string;
      serverUrl: string;
    }
  | {
      type: "validator_finished";
      timestamp: string;
      attempt: number;
      passed: boolean;
      findingCount: number;
      durationMs: number;
      infrastructureFailure?: boolean;
      infrastructureFailureReason?: string;
    }
  | {
      type: "validator_infra_aborted";
      timestamp: string;
      attempt: number;
      reason: string;
    }
  | {
      type: "repair_started";
      timestamp: string;
      attempt: number;
      promptPath: string;
    }
  | {
      type: "run_finished";
      timestamp: string;
      passed: boolean;
      attempts: number;
      reportPath: string;
    };
