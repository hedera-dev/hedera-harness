import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isMap, isScalar, parse } from "yaml";
import { z } from "zod";
import type { Command } from "./commands.js";

/** Committed, not ignored: it describes the project, not a run. */
export const CONFIG_FILE = "harness.yaml";

/** A command is either a bare string or `{ run, cwd }` with `cwd` relative to the repo root. */
const commandSchema = z
  .union([
    z.string().min(1),
    z.object({ run: z.string().min(1), cwd: z.string().min(1).optional() }),
  ])
  .transform((value): Command => (typeof value === "string" ? { run: value } : value));

export const configSchema = z.object({
  install: commandSchema,
  build: commandSchema,
  /** Absent or null when the repo has no test script. `build` has no such escape. */
  test: commandSchema.nullable().default(null),
  serve: commandSchema,
});

export type HarnessConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is not valid: ${detail}`);
    this.name = "ConfigError";
  }
}

/** Returns null when the file does not exist — the signal for a first run. */
export async function readConfig(repoRoot: string): Promise<HarnessConfig | null> {
  const path = join(repoRoot, CONFIG_FILE);
  const source = await readFile(path, "utf8").catch(() => null);
  if (source === null) return null;

  let raw: unknown;
  try {
    raw = parse(source);
  } catch (error) {
    throw new ConfigError(CONFIG_FILE, (error as Error).message);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(CONFIG_FILE, detail);
  }
  return parsed.data;
}

/** One sentence per command, emitted as the comment above it. */
export type ConfigNotes = Partial<Record<keyof HarnessConfig, string>>;

/**
 * Writes the config, with each command's rationale as the comment above it.
 * Those sentences are the reason this file is YAML rather than JSON: the
 * question a reader has months later is "why this command and not the
 * obvious-looking one", and the answer belongs next to the answer it explains.
 */
export async function writeConfig(
  repoRoot: string,
  config: HarnessConfig,
  notes: ConfigNotes = {},
): Promise<void> {
  const doc = new Document({
    install: flatten(config.install),
    build: flatten(config.build),
    test: config.test === null ? null : flatten(config.test),
    serve: flatten(config.serve),
  });

  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      const key = isScalar(item.key) ? String(item.key.value) : null;
      const note = key === null ? undefined : notes[key as keyof HarnessConfig];
      if (note !== undefined && isScalar(item.key)) item.key.commentBefore = ` ${note.trim()}`;
    }
  }

  await writeFile(join(repoRoot, CONFIG_FILE), doc.toString({ lineWidth: 0 }));
}

/** Writes `yarn install` rather than `{ run: yarn install }` when there is no cwd. */
function flatten(command: Command): string | Command {
  return command.cwd === undefined ? command.run : command;
}

/** The four commands, named, in the order a person expects to be asked about them. */
export function entries(config: HarnessConfig): Array<[string, Command | null]> {
  return [
    ["install", config.install],
    ["build", config.build],
    ["test", config.test],
    ["serve", config.serve],
  ];
}

/**
 * Checks a `yarn x` / `npm run x` command names a script that exists, before
 * anything is run. Returns null when correct, or when the command is arbitrary
 * shell we cannot check statically.
 */
export async function commandProblem(command: Command, repoRoot: string): Promise<string | null> {
  const script = scriptName(command.run);
  if (script === null) return null;

  const manifest = join(repoRoot, command.cwd ?? ".", "package.json");
  const source = await readFile(manifest, "utf8").catch(() => null);
  if (source === null) return `refers to ${command.cwd ?? "."}, which has no package.json`;

  let scripts: Record<string, unknown> = {};
  try {
    scripts = (JSON.parse(source) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return null;
  }

  return script in scripts
    ? null
    : `"${command.run}" names a script that does not exist in ${command.cwd ?? "."}/package.json`;
}

function scriptName(run: string): string | null {
  const words = run.trim().split(/\s+/);
  const [manager, second, third] = words;
  if (manager === "npm" || manager === "pnpm") {
    if (second === "run" && third !== undefined && words.length === 3) return third;
    return null;
  }
  if (manager === "yarn" && second !== undefined && words.length === 2) {
    return second === "install" ? null : second;
  }
  return null;
}
