import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  BaselineConfig,
  ChainValidationConfig,
  CommandAgentConfig,
  SecretScanConfig,
  TemplateSpec,
} from "./types.js";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_PRESET,
  DEFAULT_COMMANDS_VALIDATOR_PATH,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRD_PATH,
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_STATIC_VALIDATOR_PATH,
  HARNESS_JSONL_LOG_PATH,
  HARNESS_NOTES_LOG_PATH,
  KNOWN_SPEC_KEYS,
  MIN_SUPPORTED_SCHEMA_VERSION,
  REMOVED_SPEC_KEYS,
  SPEC_SCHEMA_VERSION,
  defaultForbiddenCommands,
  defaultSecretFiles,
  isAgentPresetName,
  type AgentPresetName,
} from "./specDefaults.js";

export async function loadTemplateSpec(specPath: string): Promise<LoadedTemplateSpec> {
  const absoluteSpecPath = path.resolve(specPath);
  const raw = await readFile(absoluteSpecPath, "utf8");
  const parsed = (parseYaml(raw) ?? {}) as Record<string, unknown>;
  const specDirectory = path.dirname(absoluteSpecPath);
  // Parent of the spec directory is the consumer project root (`.harness/spec.yaml`).
  const projectRoot = path.resolve(specDirectory, "..");
  const warnings: string[] = [];

  const schemaVersion = readSchemaVersion(parsed, absoluteSpecPath);
  rejectRemovedKeys(parsed, absoluteSpecPath);
  warnUnknownKeys(parsed, warnings);

  const constraints = readConstraints(parsed);
  const workspaces = constraints?.workspaces ?? [];
  const agent = readAgentPresetName(parsed);

  const spec: TemplateSpec = {
    schemaVersion,
    projectRoot,
    name: readString(parsed, "name"),
    description: readOptionalString(parsed, "description"),
    prdPaths: readPrdPaths(parsed, projectRoot),
    evalPath: readOptionalProjectPath(projectRoot, parsed, "eval"),
    agent,
    generator: readGenerator(parsed, agent),
    validator: readOptionalValidator(parsed, agent),
    // Keep raw refs (skill names and/or paths). resolveSkillPaths() resolves them at vendoring time.
    skills: readOptionalStringArray(parsed, "skills"),
    constraints: {
      ...constraints,
      forbiddenCommands:
        constraints?.forbiddenCommands ?? defaultForbiddenCommands(constraints?.packageManager),
    },
    templateMetadata: readTemplateMetadata(parsed),
    validators: readValidators(parsed, projectRoot),
    requiredFiles: readOptionalStringArray(parsed, "requiredFiles") ?? [],
    forbiddenFiles: readOptionalStringArray(parsed, "forbiddenFiles") ?? defaultSecretFiles(workspaces),
    secretScan: readSecretScan(parsed, workspaces),
    chainValidation: readChainValidation(parsed),
    baseline: readBaseline(parsed),
    maxAttempts: readOptionalNumber(parsed, "maxAttempts") ?? DEFAULT_MAX_ATTEMPTS,
    logging: {
      jsonlPath: resolveProjectPath(projectRoot, HARNESS_JSONL_LOG_PATH),
      notesPath: resolveProjectPath(projectRoot, HARNESS_NOTES_LOG_PATH),
    },
  };

  assertBaselineHasInstall(spec);

  for (const warning of warnings) {
    console.warn(`[hedera-harness] ${path.basename(absoluteSpecPath)}: ${warning}`);
  }

  return {
    spec,
    specPath: absoluteSpecPath,
    projectRoot,
    warnings,
  };
}

export interface LoadedTemplateSpec {
  spec: TemplateSpec;
  specPath: string;
  projectRoot: string;
  /** Deprecations and unknown keys, already logged. Returned for tests and reports. */
  warnings: string[];
}

function readSchemaVersion(parsed: Record<string, unknown>, specPath: string): number {
  const raw = parsed.schemaVersion;
  if (raw === undefined) {
    throw new Error(
      [
        `${specPath} is missing schemaVersion.`,
        `Set schemaVersion: ${SPEC_SCHEMA_VERSION}.`,
      ].join(" "),
    );
  }

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new Error(`"schemaVersion" must be a positive integer in ${specPath} (got ${JSON.stringify(raw)}).`);
  }

  if (raw > SPEC_SCHEMA_VERSION) {
    throw new Error(
      [
        `${specPath} declares schemaVersion ${raw}, but this harness understands up to ${SPEC_SCHEMA_VERSION}.`,
        `Upgrade the harness: npm install hedera-harness@latest`,
      ].join(" "),
    );
  }

  if (raw < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      [
        `${specPath} declares schemaVersion ${raw}, which this harness no longer supports.`,
        `Set schemaVersion: ${SPEC_SCHEMA_VERSION}.`,
      ].join(" "),
    );
  }

  return raw;
}

/**
 * Hard-cut removals must fail at load. Treating them as unknown keys would warn
 * "upgrade the harness" (wrong fix) and then burn a generator session before
 * EVALUATE noticed `eval` was never set.
 */
function rejectRemovedKeys(parsed: Record<string, unknown>, specPath: string): void {
  const removed = Object.keys(parsed).filter(key => key in REMOVED_SPEC_KEYS);
  if (removed.length === 0) return;

  throw new Error(
    [
      `${specPath} uses removed key(s): ${removed.join(", ")}.`,
      ...removed.map(key => REMOVED_SPEC_KEYS[key]),
    ].join(" "),
  );
}

/**
 * Unknown keys were silently ignored, so a recipe written for a newer harness could
 * lose an entire block — a renamed `baseline` would simply not run — with no error.
 */
function warnUnknownKeys(parsed: Record<string, unknown>, warnings: string[]): void {
  const unknown = Object.keys(parsed).filter(
    key => !KNOWN_SPEC_KEYS.has(key) && !(key in REMOVED_SPEC_KEYS),
  );
  if (unknown.length > 0) {
    warnings.push(
      `ignoring unknown key(s): ${unknown.join(", ")}. ` +
        "If these come from a newer recipe, upgrade the harness.",
    );
  }
}

/**
 * `prd` accepts a path or an ordered list of increments delivered in order onto
 * one branch. A single path is the common case and behaves identically.
 */
function readPrdPaths(parsed: Record<string, unknown>, projectRoot: string): string[] {
  const raw = parsed.prd;

  // No warning: the generated skeleton deliberately omits `prd`, so warning here
  // would fire on every fresh recipe. A defaulted value is the happy path, and
  // doctor reports the resolved path anyway.
  if (raw === undefined) {
    return [resolveProjectPath(projectRoot, DEFAULT_PRD_PATH)];
  }

  if (typeof raw === "string") {
    if (!raw.trim()) throw new Error('Expected non-empty string "prd" in template spec.');
    return [resolveProjectPath(projectRoot, raw)];
  }

  if (!Array.isArray(raw) || raw.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error('Expected "prd" to be a path or a non-empty list of paths.');
  }
  if (raw.length === 0) {
    throw new Error('Expected "prd" to list at least one PRD path.');
  }
  return (raw as string[]).map(value => resolveProjectPath(projectRoot, value));
}

function readValidators(
  parsed: Record<string, unknown>,
  projectRoot: string,
): TemplateSpec["validators"] {
  const validators =
    parsed.validators && typeof parsed.validators === "object" && !Array.isArray(parsed.validators)
      ? (parsed.validators as Record<string, unknown>)
      : {};

  return {
    staticPath: resolveProjectPath(
      projectRoot,
      readOptionalString(validators, "static") ?? DEFAULT_STATIC_VALIDATOR_PATH,
    ),
    commandsPath: resolveProjectPath(
      projectRoot,
      readOptionalString(validators, "commands") ?? DEFAULT_COMMANDS_VALIDATOR_PATH,
    ),
    playwrightPath: readOptionalValidatorPath(projectRoot, validators, "playwright"),
  };
}

function resolveProjectPath(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function readOptionalProjectPath(
  projectRoot: string,
  parsed: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = parsed[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`Expected optional non-empty string "${key}" in template spec.`);
  }
  return resolveProjectPath(projectRoot, candidate);
}

function readOptionalValidatorPath(
  projectRoot: string,
  validators: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = validators[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`Expected optional non-empty string "validators.${key}" in template spec.`);
  }
  return resolveProjectPath(projectRoot, candidate);
}

/**
 * Which agent CLI family the run targets.
 *
 * Kept separate from `generator:` so it still governs MCP delivery and model
 * selection when someone overrides the invocation.
 */
function readAgentPresetName(parsed: Record<string, unknown>): AgentPresetName {
  const requested = readOptionalString(parsed, "agent")?.trim() || DEFAULT_AGENT_PRESET;
  if (!isAgentPresetName(requested)) {
    throw new Error(
      [
        `Unknown agent preset ${JSON.stringify(requested)}.`,
        `Available: ${Object.keys(AGENT_PRESETS).join(", ")}.`,
      ].join(" "),
    );
  }
  return requested;
}

/** Invocation for a preset and role, with the model flag applied. */
function presetCommandConfig(
  agent: AgentPresetName,
  role: "generator" | "validator" = "generator",
  model?: string,
): CommandAgentConfig {
  const preset = AGENT_PRESETS[agent];
  const base = role === "validator" ? (preset.validatorArgs ?? preset.args) : preset.args;
  const args = [...(base ?? [])];
  args.push(preset.modelFlag, model ?? preset.defaultModel);
  return {
    provider: "command",
    command: preset.command,
    args,
    timeoutMs: preset.timeoutMs,
  };
}

/**
 * Generator wiring, from the `agent:` preset or an explicit `generator:` block.
 *
 * The preset exists so flag and model changes ship with the harness rather than
 * needing an edit in every project and template branch.
 */
function readGenerator(parsed: Record<string, unknown>, agent: AgentPresetName) {
  if (parsed.generator === undefined) {
    return presetCommandConfig(agent);
  }

  const generator = readObject(parsed, "generator");
  return {
    provider: "command" as const,
    command: readString(generator, "command"),
    args: readOptionalStringArray(generator, "args"),
    env: readOptionalStringRecord(generator, "env"),
    timeoutMs: readOptionalNumber(generator, "timeoutMs"),
  };
}

/**
 * Validator wiring. Defaults to the same preset as the generator, so enabling
 * the semantic tier is `validator: { enabled: true }` rather than a second
 * hand-maintained copy of the agent invocation.
 */
function readOptionalValidator(parsed: Record<string, unknown>, agent: AgentPresetName) {
  const validator = parsed.validator;
  if (validator === undefined) return undefined;
  if (!validator || typeof validator !== "object" || Array.isArray(validator)) {
    throw new Error('Expected object "validator" in template spec.');
  }

  const record = validator as Record<string, unknown>;
  if (record.enabled === false) {
    return {
      provider: "command" as const,
      command: readOptionalString(record, "command") ?? AGENT_PRESETS[agent].command,
      enabled: false,
    };
  }

  if (record.command === undefined) {
    return { ...presetCommandConfig(agent, "validator"), enabled: true };
  }

  return {
    provider: "command" as const,
    command: readString(record, "command"),
    args: readOptionalStringArray(record, "args"),
    env: readOptionalStringRecord(record, "env"),
    timeoutMs: readOptionalNumber(record, "timeoutMs"),
    enabled: record.enabled !== false,
  };
}

function readObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Expected object "${key}" in template spec.`);
  }
  return candidate as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new Error(`Expected non-empty string "${key}" in template spec.`);
  }
  return candidate;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
}

function readStringArray(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  if (!Array.isArray(candidate) || candidate.some(item => typeof item !== "string")) {
    throw new Error(`Expected string array "${key}" in template spec.`);
  }
  return candidate;
}

function readOptionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  return readStringArray(value, key);
}

function readOptionalStringRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`Expected string record "${key}" in template spec.`);
  }
  return Object.fromEntries(
    Object.entries(candidate).map(([entryKey, entryValue]) => {
      if (typeof entryValue !== "string") {
        throw new Error(`Expected string values in "${key}".`);
      }
      return [entryKey, entryValue];
    }),
  );
}



function readConstraints(parsed: Record<string, unknown>) {
  const constraints = parsed.constraints;
  if (!constraints || typeof constraints !== "object" || Array.isArray(constraints)) {
    return undefined;
  }
  const record = constraints as Record<string, unknown>;
  return {
    packageManager: readOptionalString(record, "packageManager"),
    workspaces: readOptionalStringArray(record, "workspaces"),
    forbiddenWorkspaces: readOptionalStringArray(record, "forbiddenWorkspaces"),
    forbiddenCommands: readOptionalStringArray(record, "forbiddenCommands"),
  };
}

function readTemplateMetadata(parsed: Record<string, unknown>) {
  const metadata = parsed.templateMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const record = metadata as Record<string, unknown>;
  return {
    name: readOptionalString(record, "name"),
    frontend: readOptionalString(record, "frontend"),
    solidityFramework: readOptionalString(record, "solidityFramework"),
  };
}

/**
 * Secret scanning defaults to the same file list as `forbiddenFiles` — every recipe
 * previously restated both, which drifts.
 */
function readSecretScan(
  parsed: Record<string, unknown>,
  workspaces: string[],
): SecretScanConfig {
  const secretScan = parsed.secretScan;
  if (!secretScan || typeof secretScan !== "object" || Array.isArray(secretScan)) {
    return {
      failOnFiles: defaultSecretFiles(workspaces),
      patterns: [...DEFAULT_SECRET_PATTERNS],
    };
  }

  const record = secretScan as Record<string, unknown>;
  const patterns = record.patterns;
  return {
    failOnFiles: Array.isArray(record.failOnFiles)
      ? (record.failOnFiles as string[])
      : defaultSecretFiles(workspaces),
    patterns: Array.isArray(patterns)
      ? (patterns as Array<{ name: string; pattern: string; allowIn?: string[] }>)
      : [...DEFAULT_SECRET_PATTERNS],
  };
}

/**
 * Host-app health commands run once before generation.
 *
 * Only the top-level `baseline:` key is accepted.
 */
function readBaseline(parsed: Record<string, unknown>): BaselineConfig | undefined {
  const record = parsed.baseline;

  if (record === undefined) return undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error('Expected object "baseline" in template spec.');
  }

  const commandsRaw = (record as Record<string, unknown>).commands;
  if (commandsRaw === undefined) return {};
  if (!Array.isArray(commandsRaw)) {
    throw new Error('Expected array "baseline.commands" in template spec.');
  }

  return {
    commands: commandsRaw.map((item, index) => {
      if (typeof item === "string") {
        return { command: item };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Expected string or object at baseline.commands[${index}].`);
      }
      const cmd = item as Record<string, unknown>;
      return {
        name: readOptionalString(cmd, "name"),
        command: readString(cmd, "command"),
        timeoutMs: readOptionalNumber(cmd, "timeoutMs"),
      };
    }),
  };
}


/** `run` requires baseline.commands with a command literally named "install". */
function assertBaselineHasInstall(spec: TemplateSpec): void {
  const commands = spec.baseline?.commands;
  if (!commands || commands.length === 0) {
    throw new Error(
      'run requires baseline.commands including a command literally named "install" '
        + '(used for host-health checks and install fingerprinting).',
    );
  }
  assertCommandsIncludeInstall(commands);
}

function assertCommandsIncludeInstall(
  commands: Array<{ name?: string; command: string }>,
): void {
  if (!commands.some(command => command.name === "install")) {
    throw new Error(
      'baseline.commands must include a command literally named "install" '
        + '(used for host-health checks and install fingerprinting).',
    );
  }
}

function readChainValidation(parsed: Record<string, unknown>): ChainValidationConfig | undefined {
  const chainValidation = parsed.chainValidation;
  if (chainValidation === undefined) return undefined;
  if (!chainValidation || typeof chainValidation !== "object" || Array.isArray(chainValidation)) {
    throw new Error('Expected object "chainValidation" in template spec.');
  }

  const record = chainValidation as Record<string, unknown>;
  if (record.enabled === false) {
    return undefined;
  }

  const network = readString(record, "network");
  if (network !== "testnet") {
    throw new Error(
      `chainValidation.network must be "testnet" (got ${JSON.stringify(network)}). Mainnet is not allowed.`,
    );
  }

  const operator = readObject(record, "operator");
  const exposeRecord =
    record.expose && typeof record.expose === "object" && !Array.isArray(record.expose)
      ? (record.expose as Record<string, unknown>)
      : {};

  const deployRecord =
    record.deploy && typeof record.deploy === "object" && !Array.isArray(record.deploy)
      ? (record.deploy as Record<string, unknown>)
      : undefined;

  let deploy: ChainValidationConfig["deploy"];
  if (deployRecord) {
    const commandsRaw = deployRecord.commands;
    if (!Array.isArray(commandsRaw)) {
      throw new Error('Expected array "chainValidation.deploy.commands" in template spec.');
    }
    deploy = {
      commands: commandsRaw.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`Expected object at chainValidation.deploy.commands[${index}].`);
        }
        const cmd = item as Record<string, unknown>;
        return {
          name: readString(cmd, "name"),
          command: readString(cmd, "command"),
          timeoutMs: readOptionalNumber(cmd, "timeoutMs"),
        };
      }),
    };
  }

  const fundingHbar = readOptionalNumber(record, "fundingHbar") ?? 10;
  if (!Number.isFinite(fundingHbar) || fundingHbar <= 0) {
    throw new Error('Expected positive number "chainValidation.fundingHbar".');
  }

  return {
    enabled: record.enabled !== false,
    network: "testnet",
    operator: {
      accountIdEnv: readString(operator, "accountIdEnv"),
      privateKeyEnv: readString(operator, "privateKeyEnv"),
    },
    fundingHbar,
    sweepBack: record.sweepBack !== false,
    expose: {
      browserLocalStorageKey:
        typeof exposeRecord.browserLocalStorageKey === "string" &&
        exposeRecord.browserLocalStorageKey.trim()
          ? exposeRecord.browserLocalStorageKey.trim()
          : "burnerWallet.pk",
      envVars: readOptionalStringArray(exposeRecord, "envVars") ?? [],
    },
    deploy,
  };
}
