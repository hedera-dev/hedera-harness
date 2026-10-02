import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { aside, terminal } from "./ask.js";
import { type Command, describe } from "./commands.js";
import {
  CONFIG_FILE,
  type HarnessConfig,
  commandProblem,
  entries,
  readConfig,
  writeConfig,
} from "./config.js";
import { emit } from "./events.js";
import { commit } from "./git.js";

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitOptions {
  repoRoot: string;
  /** Take every default without asking. Required when stdin is not a terminal. */
  assumeYes: boolean;
}

/**
 * What the repo itself says the answers are. A default is offered only when
 * it was there to be read — the lockfile names the package manager, the
 * manifest names the scripts — because a guessed default that is wrong is
 * worse than an empty prompt.
 */
export interface Defaults {
  install: Command;
  /** Undefined when the manifest has no build script — the user must name one. */
  build?: Command | undefined;
  /** Null when the manifest has no real test script. "None" is a real answer. */
  test: Command | null;
  /** Undefined when no dev-server script was found. */
  serve?: Command | undefined;
}

/**
 * Writes `harness.yaml` by asking, not by agent.
 *
 * Four questions, with defaults read from the project itself. The commands are
 * not run here: a wrong one fails DOCTOR's baseline on the first run, with its
 * output, which is where a wrong command is cheapest to recognise.
 */
export async function initialise(options: InitOptions): Promise<HarnessConfig> {
  const { repoRoot } = options;
  if ((await readConfig(repoRoot)) !== null) {
    throw new InitError(`${CONFIG_FILE} already exists — edit it directly.`);
  }

  const detected = await detectDefaults(repoRoot);
  const config = options.assumeYes ? complete(detected) : await askForCommands(repoRoot, detected);

  await writeConfig(repoRoot, config);
  // Committed where the project lives: an uncommitted config is dirt, and
  // DOCTOR's clean-tree check would refuse the first run over its own setup.
  await commit([CONFIG_FILE], `chore: record harness commands in ${CONFIG_FILE}`, repoRoot);

  emit({
    type: "config:written",
    file: CONFIG_FILE,
    commands: entries(config).map(([name, command]) => ({ name, command })),
  });
  return config;
}

/** Exported for tests: the defaults a repo would be offered. */
export async function detectDefaults(repoRoot: string): Promise<Defaults> {
  const pm = await packageManager(repoRoot);
  const scripts = await readScripts(repoRoot);

  // Idiomatic per manager: `yarn build`, but `npm run build`.
  const run = (script: string): Command =>
    pm === "npm" ? { run: `npm run ${script}` } : { run: `${pm} ${script}` };

  const server = ["dev", "start", "serve"].find((name) => name in scripts);
  const test = scripts["test"];
  const hasRealTest = test !== undefined && !test.includes("no test specified");

  return {
    install: { run: `${pm} install` },
    build: "build" in scripts ? run("build") : undefined,
    test: hasRealTest ? (pm === "npm" ? { run: "npm test" } : { run: `${pm} test` }) : null,
    serve: server === undefined ? undefined : run(server),
  };
}

async function askForCommands(repoRoot: string, detected: Defaults): Promise<HarnessConfig> {
  const asker = terminal();
  try {
    const install = await askOne(asker, repoRoot, "install", detected.install);
    const build = await askOne(asker, repoRoot, "build", detected.build);
    const test = await askTest(asker, repoRoot, detected.test);
    const serve = await askOne(asker, repoRoot, "serve", detected.serve);
    return { install, build, test, serve };
  } finally {
    asker.close();
  }
}

/**
 * One question. Empty takes the default; with no default there is no empty.
 * A command that names a missing script is warned about and accepted anyway —
 * it may be arbitrary shell we cannot check, and the baseline is the real test.
 */
async function askOne(
  asker: ReturnType<typeof terminal>,
  repoRoot: string,
  name: string,
  fallback: Command | undefined,
): Promise<Command> {
  const hint = fallback === undefined ? "" : ` [${describe(fallback)}]`;
  for (;;) {
    const answer = (await asker.ask(`${name}${hint} › `)).trim();
    const command = answer === "" ? fallback : { run: answer };
    if (command !== undefined) {
      const problem = await commandProblem(command, repoRoot);
      if (problem !== null) aside(`  warning: ${problem}`);
      return command;
    }
  }
}

/** `test` alone may be "none" — a repo without tests is a fact, not an error. */
async function askTest(
  asker: ReturnType<typeof terminal>,
  repoRoot: string,
  fallback: Command | null,
): Promise<Command | null> {
  const hint = fallback === null ? ' [(none)]' : ` [${describe(fallback)}, or "none"]`;
  const answer = (await asker.ask(`test${hint} › `)).trim();
  if (answer === "none" || answer === "null") return null;
  if (answer === "") return fallback;
  const command = { run: answer };
  const problem = await commandProblem(command, repoRoot);
  if (problem !== null) aside(`  warning: ${problem}`);
  return command;
}

/** `--yes` takes the defaults whole; a missing one is the one thing it cannot take. */
function complete(detected: Defaults): HarnessConfig {
  if (detected.build === undefined || detected.serve === undefined) {
    throw new InitError(
      "could not detect a build or serve script from package.json — " +
        "run without --yes to answer for yourself.",
    );
  }
  return {
    install: detected.install,
    build: detected.build,
    test: detected.test,
    serve: detected.serve,
  };
}

async function packageManager(repoRoot: string): Promise<string> {
  const lockfiles: Record<string, string> = {
    "yarn.lock": "yarn",
    "pnpm-lock.yaml": "pnpm",
    "bun.lockb": "bun",
    "package-lock.json": "npm",
  };
  for (const [file, manager] of Object.entries(lockfiles)) {
    const found = await readFile(join(repoRoot, file), "utf8").then(
      () => true,
      () => false,
    );
    if (found) return manager;
  }
  return "npm";
}

async function readScripts(repoRoot: string): Promise<Record<string, string>> {
  const source = await readFile(join(repoRoot, "package.json"), "utf8").catch(() => null);
  if (source === null) return {};
  try {
    return (JSON.parse(source) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}
