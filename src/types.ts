import type { AgentProgress } from "./agentStreamLogger.js";

export type HarnessCommand =
  | "init"
  | "run"
  | "doctor"
  | "validate"
  | "validate-semantic";

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
  /** Spec path; defaults to `.harness/spec.yaml` for project-centric `run`. */
  specPath: string;
  maxAttempts?: number;
  workspacePath?: string;
  /** Force a new `harness/run-*` branch even when current branch matches the spec. */
  forceNew?: boolean;
  /** Explicit harness branch to checkout and continue. */
  continueBranch?: string;
  /** `doctor` only: check the recipe alone, skipping host and project checks. */
  recipeOnly?: boolean;
}

export interface InitCliOptions {
  targetDir?: string;
  repo?: string;
  ref?: string;
  /** Alias for ref (e.g. scaffold template branch). */
  template?: string;
  skipInstall?: boolean;
}

export interface InitResult {
  /** `seeded` cloned a scaffold; `in-place` adopted the project already present. */
  mode: "seeded" | "in-place";
  targetDir: string;
  /** Absent when adopting an existing project — nothing was cloned. */
  repo?: string;
  ref?: string;
  commitSha?: string;
  harnessDir: string;
  writtenFiles: string[];
  /** Recipe files already present and left untouched. */
  skippedFiles: string[];
  gitignoreUpdated: boolean;
  packageJsonUpdated: boolean;
  nextSteps: string[];
}

export interface ParsedCli {
  command: HarnessCommand;
  options: CliOptions;
  initOptions?: InitCliOptions;
}

export interface AgentRunInput {
  workspacePath: string;
  prompt: string;
  attempt: number;
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

export interface PreflightCommandConfig {
  name?: string;
  command: string;
  timeoutMs?: number;
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

/** An additional named ephemeral signer, provisioned the same way as the primary one. */
export interface ChainValidationActorConfig {
  /** Defaults to chainValidation.fundingHbar when omitted. */
  fundingHbar?: number;
}

export type ChainAssertionOutcome = "mustSucceed" | "mustRevert";

/**
 * Deterministic balance-delta check, composable with outcome. `asset` is HBAR or an HTS
 * token id; `equals` is a signed integer as a string (tinybars for HBAR, smallest unit for
 * HTS) to avoid floating-point precision loss.
 */
export interface ChainAssertionBalanceDeltaConfig {
  /** Hedera account id (0.0.x) the balance is sampled on. Exactly one of account/accountEnv. */
  account?: string;
  /** Env var holding the account id at execution time (e.g. an actor's own account). */
  accountEnv?: string;
  asset: "hbar" | { tokenId: string };
  equals: string;
}

export interface ChainAssertionExpectConfig {
  outcome: ChainAssertionOutcome;
  /** Only meaningful with outcome: "mustRevert" — substring match against the failure reason. */
  reasonContains?: string;
  balanceDelta?: ChainAssertionBalanceDeltaConfig;
}

/**
 * A single deterministic on-chain behavioral postcondition: execute `action` with `actor`'s
 * signer (default: the primary chainSigner), then evaluate `expect` against real chain
 * evidence — never an LLM judgment. See docs/authoring-a-recipe.md.
 */
export interface ChainAssertionConfig {
  /** Stable across repair attempts — reused findings/report ids are keyed on this. */
  id: string;
  description?: string;
  /** Name of an entry in chainValidation.actors. Omitted = the primary chainSigner. */
  actor?: string;
  /** Same shape as a deploy command — one named shell step, signer env vars injected. */
  action: ChainValidationDeployCommand;
  expect: ChainAssertionExpectConfig;
}

/**
 * Optional on-chain validation: provision an ephemeral funded ECDSA
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
  /** Additional named ephemeral signers, alongside the primary chainSigner. */
  actors?: Record<string, ChainValidationActorConfig>;
  /** Deterministic on-chain behavioral postcondition checks. See ChainAssertionConfig. */
  assertions?: ChainAssertionConfig[];
}

/** Ephemeral ECDSA test signer provisioned for a harness run. */
export interface ChainSigner {
  accountId: string;
  privateKeyHex: string;
  evmAddress: string;
  network: "testnet";
}

export interface BaselineCommandConfig {
  name?: string;
  command: string;
  timeoutMs?: number;
}

export interface BaselineConfig {
  /** Non-target health checks run once after branch creation (before generation). */
  commands?: BaselineCommandConfig[];
}

export interface TemplateSpec {
  /** Recipe schema version. Absent in the file means 1 (the original schema). */
  schemaVersion: number;
  /** Directory containing `.harness/`. Used to resolve prompt overrides. */
  projectRoot: string;
  name: string;
  description?: string;
  /** Ordered feature descriptions delivered as increments onto one branch. */
  prdPaths: string[];
  /**
   * Absolute evaluate-checklist paths. Undefined = no eval configured.
   * Length 1 (scalar) grades every slice with the same checklist; length N
   * must match `prdPaths` for per-slice grading.
   */
  evalPaths?: string[];
  /**
   * Which agent CLI family this run targets. Drives MCP delivery and model
   * selection even when `generator:` overrides the invocation itself.
   */
  agent: "cursor" | "claude";
  generator: CommandAgentConfig;
  validator?: ValidatorAgentConfig;
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
  /** Host-app health commands run once before generation. */
  baseline?: BaselineConfig;
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
  assertion?: string;
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

export interface EvaluationResult {
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
    | "playwright"
    | "eval"
    | "eval-infra"
    | "chain-assertion"
    | "chain-assertion-infra";
  message: string;
  details?: string;
  /**
   * Lifecycle across attempts. `fixed` findings are carried forward from a prior
   * attempt to show what the last repair closed; they are not failures.
   */
  status?: "open" | "fixed";
  /** Evaluate-checklist assertion id when category is eval (e.g. E7). */
  assertion?: string;
  /** Route associated with an eval finding, when known. */
  route?: string;
  /** Deterministic on-chain evidence for a chain-assertion finding. */
  evidence?: {
    transactionId?: string;
    expected?: string;
    observed?: string;
  };
}

export interface ValidationResult {
  passed: boolean;
  findings: ValidationFinding[];
  commandResults: CommandExecutionResult[];
  playwrightGate?: PlaywrightGateResult;
  evaluation?: EvaluationResult;
}

/** Outcome of one increment in an ordered `prd:` list. */
export interface SliceReport {
  /** Zero-based position in `prd:`. */
  index: number;
  prdPath: string;
  /** Absolute eval path for this slice, when EVALUATE is configured. */
  evalPath?: string;
  passed: boolean;
  /** Attempts consumed by this increment alone. */
  attempts: number;
  openFindingIds: string[];
}

export interface RunReport {
  specName: string;
  specPath: string;
  runDirectory: string;
  workspacePath: string;
  attempts: number;
  maxAttempts: number;
  /** Set when this kick was a --continue cycle (1-based). */
  cycle?: number;
  /** Attempts consumed in this kick only (fresh maxAttempts budget). */
  attemptsThisCycle?: number;
  /** True when deterministic, playwright gate, and evaluation (if configured) all pass. */
  passed: boolean;
  /** Finding ids still failing when the run stopped. */
  openFindingIds: string[];
  /** Finding ids the final attempt closed. */
  fixedFindingIds: string[];
  /** One entry per increment attempted this kick. Single-PRD recipes have one. */
  slices?: SliceReport[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  validation: ValidationResult;
  evaluation?: EvaluationResult;
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
      type: "skills_vendored";
      timestamp: string;
      count: number;
      workspaceSkillsDir: string;
    }
  | {
      type: "context_vendored";
      timestamp: string;
      prdPath: string;
      evalPath?: string;
      workspaceContextDir: string;
    }
  | {
      type: "chain_signer_provisioned";
      timestamp: string;
      accountId: string;
      evmAddress: string;
      network: "testnet";
      reused: boolean;
      /** Name of the chainValidation.actors entry this signer is for; absent = the primary signer. */
      actor?: string;
    }
  | {
      type: "chain_signer_swept";
      timestamp: string;
      accountId: string;
      success: boolean;
      error?: string;
      /** Name of the chainValidation.actors entry this signer is for; absent = the primary signer. */
      actor?: string;
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
      type: "validation_finished";
      timestamp: string;
      attempt: number;
      passed: boolean;
      findingCount: number;
      openFindingIds?: string[];
      fixedFindingIds?: string[];
      introducedFindingIds?: string[];
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
