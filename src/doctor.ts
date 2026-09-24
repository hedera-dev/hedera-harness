import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Command, runCommand } from "./commands.js";
import { CONFIG_FILE, type HarnessConfig, readConfig, writeConfig } from "./config.js";
import type { Check } from "./checks.js";
import { derive } from "./derive.js";
import { emit } from "./events.js";
import { funding, mirrorNode, wallet } from "./wallet.js";
import { describeFailure, fromStage } from "./failure.js";
import { commit, dirtyPaths } from "./git.js";
import { type Proposal, resolveCommands } from "./resolve.js";
import type { Run } from "./run.js";
import { ServeError, startServer } from "./serve.js";
import { runStages } from "./test.js";

/** See PLAN-V2 § Bounds. Starting points, to be tuned once there are real runs. */
const RESOLVE_TIMEOUT_MS = 5 * 60_000;

export class DoctorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorError";
  }
}

export interface DoctorOptions {
  repoRoot: string;
  /** The spec's text, so checks can be read from it before anything is built. */
  spec?: string | undefined;
  /** Where the app will run, for the routes a derived check names. */
  appUrlHint: string;
  /** Stop and confirm the derived checks rather than showing them and going on. */
  review: boolean;
  run: Run;
  model: string;
  /** Repo-relative path of the spec, when it lives inside the repo. Not treated as dirt. */
  specPath?: string | undefined;
  /** Skip the first-run confirmation. Required when stdin is not a terminal. */
  assumeYes: boolean;
}

/**
 * Everything that must hold before an agent is allowed to touch the repo.
 * A check belongs here only if failing it would abort a run rather than fail a
 * test — the point is to spend four seconds instead of forty minutes.
 */
export interface Examined {
  config: HarnessConfig;
  /** What the spec itself says can be settled, before the app exists. */
  checks: Check[];
}

export async function doctor(options: DoctorOptions): Promise<Examined> {
  const { repoRoot, run } = options;

  emit({ type: "phase:started", phase: "doctor" });
  await checkTooling(repoRoot);

  const dirty = await dirtyPaths(
    repoRoot,
    options.specPath === undefined ? [] : [options.specPath],
  );
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 5).join(", ");
    throw new DoctorError(
      `the working tree has uncommitted changes (${shown}${dirty.length > 5 ? ", …" : ""}). ` +
        `Commit or stash them first — the run needs a known starting point to branch from.`,
    );
  }
  emit({ type: "check", name: "tree clean", ok: true });

  await checkSkills(repoRoot);
  await checkBrowser();
  await checkWallet();

  const existing = await readConfig(repoRoot);
  const proposal = existing === null ? await resolve(options) : null;
  const config = existing ?? proposal!.config;
  if (existing !== null) emit({ type: "check", name: `commands from ${CONFIG_FILE}`, ok: true });

  // Every run, not just the first. On a first run this proves the resolution
  // works before it is written down; on every run it proves the repo was
  // healthy before the agent touched it, so pre-existing breakage is never
  // charged to the generator as a failed attempt.
  await verifyByRunning(config, repoRoot, run);

  if (proposal !== null) {
    await writeConfig(repoRoot, config, proposal.notes);
    await commit([CONFIG_FILE], `chore: record harness commands in ${CONFIG_FILE}`, repoRoot);
    emit({ type: "check", name: `wrote and committed ${CONFIG_FILE}`, ok: true });
  }

  return { config, checks: await deriveChecks(options) };
}

/**
 * What the spec says can be settled, read before anything is built.
 *
 * Shown rather than asked about. Confirming by default would put an
 * interaction on the main path *per spec*, where the command prompt is per
 * project and never seen again — and whether a check says what you meant is
 * usually only visible once it has run. `--review` is there for anyone who
 * disagrees.
 */
async function deriveChecks(options: DoctorOptions): Promise<Check[]> {
  if (options.spec === undefined) return [];

  const checks = await derive(options.spec, options.appUrlHint, options.model);
  if (checks.length === 0) return [];

  emit({ type: "derived", checks });
  if (options.review) await confirm(options);
  return checks;
}

/**
 * A scaffolded project carries its own skills in `.claude/skills/`, which the
 * generator loads automatically. A project without them still runs, just with
 * less Hedera knowledge behind it — worth saying out loud rather than leaving
 * the operator to wonder why the output is thin.
 */
async function checkSkills(repoRoot: string): Promise<void> {
  // Counted by the SKILL.md inside, not by directory type: a scaffolded
  // project symlinks .claude/skills/* at .agents/skills/*, and readdir reports
  // a symlink as a symlink, so an isDirectory() check reports none of them.
  const skillsDir = join(repoRoot, ".claude", "skills");
  const entries = await readdir(skillsDir).catch(() => [] as string[]);
  const found = entries.filter((entry) => existsSync(join(skillsDir, entry, "SKILL.md"))).length;

  if (found > 0) {
    emit({ type: "check", name: `${found} project skills in .claude/skills`, ok: true });
    return;
  }
  if (process.env["HEDERA_SKILLS_DIR"] !== undefined) {
    emit({ type: "check", name: "skills from HEDERA_SKILLS_DIR", ok: true });
    return;
  }
  emit({
    type: "check",
    name: "no project skills — the agent works without Hedera-specific knowledge",
    ok: false,
    remedy: "add them with: claude plugin marketplace add hedera-dev/hedera-skills",
  });
}

/**
 * EVALUATE drives a real browser, and a missing one surfaces halfway through
 * judging — after generation has been paid for, which is the forty minutes
 * DOCTOR exists to save.
 *
 * Only the certain case is reported: an empty cache means EVALUATE cannot
 * work. Which build `playwright-cli` picks is its own business, and guessing
 * at that would produce a false alarm on a machine where it runs fine.
 */
async function checkBrowser(): Promise<void> {
  const entries = await readdir(browserCache()).catch(() => [] as string[]);
  if (entries.some((entry) => entry.startsWith("chromium"))) {
    emit({ type: "check", name: "browser for the evaluator", ok: true });
    return;
  }
  emit({
    type: "check",
    name: "no browser installed — EVALUATE drives one and will fail without it",
    ok: false,
    remedy: "install it with: npx playwright install chromium",
  });
}

/** Playwright's documented cache locations, and the variable that overrides them. */
function browserCache(): string {
  const override = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (override !== undefined) return override;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(homedir(), "AppData", "Local", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

/**
 * The account the app will sign with, if one was given. Absent is fine — most
 * specs are read-only — but an account that does not exist or cannot pay is a
 * run that will fail confusingly much later, blaming the app for it.
 */
async function checkWallet(): Promise<void> {
  const supplied = wallet();
  if (supplied === null) {
    emit({
      type: "check",
      name: "no wallet — the evaluator can read the chain but not sign",
      ok: false,
      remedy: "for transactional specs, export HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY",
    });
    return;
  }

  const state = await funding(mirrorNode(), supplied.id);
  if (state.state === "ok") {
    emit({ type: "check", name: `wallet ${supplied.id} holds ${state.hbar.toFixed(2)} ℏ`, ok: true });
    return;
  }
  if (state.state === "low") {
    emit({
      type: "check",
      name: `wallet ${supplied.id} holds only ${state.hbar.toFixed(2)} ℏ`,
      ok: false,
      remedy: "top it up at portal.hedera.com/faucet",
    });
    return;
  }
  throw new DoctorError(
    `the wallet HEDERA_OPERATOR_ID names cannot be read: ${state.reason}. ` +
      `Check the id, or unset it to run without a wallet.`,
  );
}

async function checkTooling(repoRoot: string): Promise<void> {
  const missing: string[] = [];
  for (const binary of ["node", "git"]) {
    if (!(await exists(binary, repoRoot))) missing.push(binary);
  }
  if (missing.length > 0) {
    throw new DoctorError(`not on PATH: ${missing.join(", ")}`);
  }
  emit({ type: "check", name: "tooling", ok: true });
}

async function exists(binary: string, cwd: string): Promise<boolean> {
  const result = await runCommand({ run: `command -v ${binary}` }, cwd, 10_000);
  return result.code === 0;
}

async function resolve(options: DoctorOptions): Promise<Proposal> {
  const { repoRoot } = options;
  emit({ type: "note", level: "info", text: "resolving commands" });

  const proposal = await resolveCommands(repoRoot, RESOLVE_TIMEOUT_MS, options.model);
  const { config, notes } = proposal;

  for (const [name, command] of entries(config)) {
    if (command === null) continue;
    const problem = await scriptProblem(command, repoRoot);
    if (problem !== null) throw new DoctorError(`proposed ${name} command ${problem}`);
  }

  emit({
    type: "proposal",
    commands: entries(config).map(([name, command]) => ({
      name,
      command,
      note: notes[name as keyof typeof notes],
    })),
  });

  await confirm(options);
  return proposal;
}

function entries(config: HarnessConfig): Array<[string, Command | null]> {
  return [
    ["install", config.install],
    ["build", config.build],
    ["test", config.test],
    ["serve", config.serve],
  ];
}

async function confirm(options: DoctorOptions): Promise<void> {
  if (options.assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new DoctorError(
      `first run needs confirmation but stdin is not a terminal. ` +
        `Re-run with --yes, or create ${CONFIG_FILE} by hand.`,
    );
  }

  // The prompt goes to stderr, not stdout: stdout carries the run, and under
  // `--json` a line of English in it would break every consumer.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Use these? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new DoctorError(`declined. Write ${CONFIG_FILE} by hand and run again.`);
    }
  } finally {
    rl.close();
  }
}

/**
 * A resolution is only worth recording once it has actually run, and a repo is
 * only worth generating into once it was already healthy. Both use the same
 * code path an attempt will use, so the commands that proved the repo healthy
 * are exactly the commands the agent is later judged against.
 */
async function verifyByRunning(
  config: HarnessConfig,
  repoRoot: string,
  run: Run,
): Promise<void> {
  const failure = await runStages({ config, repoRoot, run, prefix: "baseline" });
  if (failure !== null) {
    throw new DoctorError(
      `baseline ${describeFailure(fromStage(failure))} on the untouched repo. ` +
        `Either the command is wrong or the project is already broken — ` +
        `output is in ${join(run.dir, failure.artifact)}`,
    );
  }

  // `serve` is the one command the stages above cannot check: it never exits.
  // Starting it here turns a wrong dev-server command into a four-second
  // failure instead of one discovered after a generation has been paid for.
  emit({ type: "command:started", name: "serve", command: config.serve });
  let server;
  try {
    server = await startServer(config.serve, repoRoot);
  } catch (error) {
    if (error instanceof ServeError) {
      await run.write(join("baseline", "serve.txt"), error.output);
      throw new DoctorError(
        `baseline serve failed: ${error.message} — ` +
          `output is in ${join(run.dir, "baseline", "serve.txt")}`,
      );
    }
    throw error;
  }

  await run.write(join("baseline", "serve.txt"), server.output());
  emit({ type: "check", name: `serve answered at ${server.url}`, ok: true });
  await server.stop();
}

/**
 * Checks a `yarn x` / `npm run x` command names a script that exists, before
 * anything is run. Returns null when correct, or when the command is arbitrary
 * shell we cannot check statically.
 */
async function scriptProblem(command: Command, repoRoot: string): Promise<string | null> {
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
