import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ChainValidationConfig, SecretScanConfig, TemplateSpec } from "./types.js";

export async function loadTemplateSpec(specPath: string): Promise<LoadedTemplateSpec> {
  const absoluteSpecPath = path.resolve(specPath);
  const raw = await readFile(absoluteSpecPath, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  const specDirectory = path.dirname(absoluteSpecPath);
  const projectRoot = path.resolve(specDirectory, "..");

  const spec: TemplateSpec = {
    name: readString(parsed, "name"),
    description: readOptionalString(parsed, "description"),
    prdPath: resolveProjectPath(projectRoot, readString(parsed, "prd")),
    contractPath: readOptionalProjectPath(projectRoot, parsed, "contract"),
    seed: readSeed(parsed),
    generator: readGenerator(parsed),
    validator: readOptionalValidator(parsed),
    // Keep raw refs (skill names and/or paths). resolveSkillPaths() resolves them at vendoring time.
    skills: readOptionalStringArray(parsed, "skills"),
    constraints: readConstraints(parsed),
    templateMetadata: readTemplateMetadata(parsed),
    validators: {
      staticPath: resolveProjectPath(projectRoot, readString(readObject(parsed, "validators"), "static")),
      commandsPath: resolveProjectPath(
        projectRoot,
        readString(readObject(parsed, "validators"), "commands"),
      ),
      playwrightPath: readOptionalValidatorPath(projectRoot, readObject(parsed, "validators"), "playwright"),
    },
    requiredFiles: readStringArray(parsed, "requiredFiles"),
    forbiddenFiles: readStringArray(parsed, "forbiddenFiles"),
    secretScan: readSecretScan(parsed),
    chainValidation: readChainValidation(parsed),
    maxAttempts: readOptionalNumber(parsed, "maxAttempts") ?? 3,
    logging: {
      jsonlPath: resolveProjectPath(projectRoot, readString(readObject(parsed, "logging"), "jsonl")),
      notesPath: resolveProjectPath(projectRoot, readString(readObject(parsed, "logging"), "notes")),
    },
  };

  return {
    spec,
    specPath: absoluteSpecPath,
    projectRoot,
  };
}

export interface LoadedTemplateSpec {
  spec: TemplateSpec;
  specPath: string;
  projectRoot: string;
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

function readSeed(parsed: Record<string, unknown>) {
  const seed = readObject(parsed, "seed");
  return {
    repo: readString(seed, "repo"),
    ref: readString(seed, "ref"),
    preflight: readOptionalPreflight(seed),
    isolation: readOptionalIsolation(seed),
  };
}

function readGenerator(parsed: Record<string, unknown>) {
  const generator = readObject(parsed, "generator");
  return {
    provider: "command" as const,
    command: readString(generator, "command"),
    args: readOptionalStringArray(generator, "args"),
    env: readOptionalStringRecord(generator, "env"),
    timeoutMs: readOptionalNumber(generator, "timeoutMs"),
  };
}

function readOptionalValidator(parsed: Record<string, unknown>) {
  const validator = parsed.validator;
  if (validator === undefined) return undefined;
  if (!validator || typeof validator !== "object" || Array.isArray(validator)) {
    throw new Error('Expected object "validator" in template spec.');
  }

  const record = validator as Record<string, unknown>;
  if (record.enabled === false) {
    return {
      provider: "command" as const,
      command: readOptionalString(record, "command") ?? "agent",
      enabled: false,
    };
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

function readOptionalPreflight(seed: Record<string, unknown>) {
  const preflight = seed.preflight;
  if (!preflight || typeof preflight !== "object" || Array.isArray(preflight)) {
    return undefined;
  }
  const commands = (preflight as Record<string, unknown>).commands;
  if (!Array.isArray(commands)) return undefined;
  return {
    commands: commands as Array<string | { name?: string; command: string; timeoutMs?: number }>,
  };
}

function readOptionalIsolation(seed: Record<string, unknown>) {
  const isolation = seed.isolation;
  if (!isolation || typeof isolation !== "object" || Array.isArray(isolation)) {
    return undefined;
  }
  const record = isolation as Record<string, unknown>;
  return {
    neverModifySeedRepo: record.neverModifySeedRepo === true,
    separateFolder: record.separateFolder === true,
    excludeFromArtifact: Array.isArray(record.excludeFromArtifact)
      ? (record.excludeFromArtifact as string[])
      : undefined,
  };
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

function readSecretScan(parsed: Record<string, unknown>): SecretScanConfig | undefined {
  const secretScan = parsed.secretScan;
  if (!secretScan || typeof secretScan !== "object" || Array.isArray(secretScan)) {
    return undefined;
  }
  const record = secretScan as Record<string, unknown>;
  const patterns = record.patterns;
  return {
    failOnFiles: Array.isArray(record.failOnFiles) ? (record.failOnFiles as string[]) : [],
    patterns: Array.isArray(patterns)
      ? (patterns as Array<{ name: string; pattern: string; allowIn?: string[] }>)
      : [],
  };
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
