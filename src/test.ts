import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Command, type CommandResult, runCommand } from "./commands.js";
import { emit } from "./events.js";
import type { HarnessConfig } from "./config.js";
import type { Run } from "./run.js";

/** Per command. A build or test that never returns is a defect, not a hang. */
const COMMAND_TIMEOUT_MS = 20 * 60_000;

const FINGERPRINT_FILE = "install-fingerprint.txt";

export type Stage = "install" | "build" | "test";

export interface StageFailure {
  stage: Stage;
  command: Command;
  code: number | null;
  timedOut: boolean;
  /** The bound this command ran under. Carried so nothing has to hardcode it to say so. */
  timeoutMs: number;
  /** Where the full output was written, for the repair prompt to point at. */
  artifact: string;
  output: string;
}

export interface StageOptions {
  config: HarnessConfig;
  repoRoot: string;
  run: Run;
  /** Artifact subdirectory — `baseline` or `attempt-2`. */
  prefix: string;
  /** Whose commands these are. Absent for DOCTOR's baseline. */
  attempt?: number | undefined;
  /** Run `install` even when nothing about the dependencies changed. */
  forceInstall?: boolean;
}

/**
 * `install`, then `build`, then `test`, stopping at the first non-zero exit.
 * Returns null when everything passed, or the failure that stopped it.
 *
 * The same function serves DOCTOR's baseline and every attempt's TEST — one
 * code path, so the commands that proved the repo healthy are exactly the
 * commands the agent is later judged against.
 */
export async function runStages(options: StageOptions): Promise<StageFailure | null> {
  const { config } = options;

  const install = await installIfNeeded(options);
  if (install !== null) return install;

  const remaining: Array<[Stage, Command | null]> = [
    ["build", config.build],
    ["test", config.test],
  ];

  for (const [stage, command] of remaining) {
    if (command === null) {
      emit({ type: "command:skipped", name: stage, reason: "none", attempt: options.attempt });
      continue;
    }
    const failure = await runStage(stage, command, options);
    if (failure !== null) return failure;
  }
  return null;
}

/**
 * Installing is the expensive step and dependencies rarely move, so it runs
 * only when the manifests or the lockfile actually changed since last time.
 */
async function installIfNeeded(options: StageOptions): Promise<StageFailure | null> {
  const { config, repoRoot, run } = options;
  const current = await fingerprint(repoRoot);
  const recorded = await readFile(join(run.dir, FINGERPRINT_FILE), "utf8").catch(() => null);

  if (!options.forceInstall && recorded === current) {
    emit({
      type: "command:skipped",
      name: "install",
      reason: "dependencies unchanged",
      attempt: options.attempt,
    });
    return null;
  }

  const failure = await runStage("install", config.install, options);
  if (failure !== null) return failure;

  await writeFile(join(run.dir, FINGERPRINT_FILE), current);
  return null;
}

async function runStage(
  stage: Stage,
  command: Command,
  { repoRoot, run, prefix, attempt }: StageOptions,
): Promise<StageFailure | null> {
  emit({ type: "command:started", name: stage, command, attempt });
  const result = await runCommand(command, repoRoot, COMMAND_TIMEOUT_MS, (elapsedMs, line) => {
    emit({ type: "command:tick", elapsedMs, line, attempt });
  });

  const artifact = join(prefix, `${stage}.txt`);
  await run.write(artifact, result.output);

  if (succeeded(result)) return null;
  return {
    stage,
    command,
    code: result.code,
    timedOut: result.timedOut,
    timeoutMs: COMMAND_TIMEOUT_MS,
    artifact,
    output: result.output,
  };
}

function succeeded(result: CommandResult): boolean {
  return result.code === 0 && !result.timedOut;
}

/**
 * Hashes the manifests and the lockfile. Content rather than mtime, so a
 * checkout that rewrites files without changing them does not trigger a
 * reinstall.
 */
async function fingerprint(repoRoot: string): Promise<string> {
  const candidates = [
    "package.json",
    "yarn.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "bun.lockb",
  ];
  const hash = createHash("sha256");
  for (const name of candidates) {
    const source = await readFile(join(repoRoot, name)).catch(() => null);
    if (source !== null) hash.update(name).update(source);
  }
  return `${hash.digest("hex")}\n`;
}
