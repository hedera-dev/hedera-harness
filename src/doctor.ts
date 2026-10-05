import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./commands.js";
import { CONFIG_FILE, type HarnessConfig, commandProblem, entries, readConfig } from "./config.js";
import { browserCache } from "./evaluate.js";
import { emit } from "./events.js";
import { funding, mirrorNode, wallet } from "./wallet.js";
import { describeFailure, fromStage } from "./failure.js";
import { dirtyPaths } from "./git.js";
import type { Run } from "./run.js";
import { ServeError, startServer } from "./serve.js";
import { runStages } from "./test.js";

export class DoctorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorError";
  }
}

export interface DoctorOptions {
  repoRoot: string;
  run: Run;
  /** Repo-relative path of the spec, when it lives inside the repo. Not treated as dirt. */
  specPath?: string | undefined;
}

/**
 * Everything that must hold before an agent is allowed to touch the repo.
 * A check belongs here only if failing it would abort a run rather than fail a
 * test — the point is to spend four seconds instead of forty minutes.
 *
 * Deterministic on purpose: the commands come from `harness.yaml` or the run
 * stops. `init` owns setup, so nothing here asks a model anything.
 */
export async function doctor(options: DoctorOptions): Promise<HarnessConfig> {
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

  const config = await readConfig(repoRoot);
  if (config === null) {
    throw new DoctorError(
      `no ${CONFIG_FILE}. Run \`harness init\` to write one.`,
    );
  }
  emit({ type: "check", name: `commands from ${CONFIG_FILE}`, ok: true });

  // Scripts get renamed. Catching that here is four seconds; catching it in the
  // baseline is a log to read.
  for (const [name, command] of entries(config)) {
    if (command === null) continue;
    const problem = await commandProblem(command, repoRoot);
    if (problem !== null) throw new DoctorError(`configured ${name} command ${problem}`);
  }

  // Every run, not just the first: it proves the repo was healthy before the
  // agent touched it, so pre-existing breakage is never charged to the
  // generator as a failed attempt.
  await verifyByRunning(config, repoRoot, run);

  return config;
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
  const dirEntries = await readdir(skillsDir).catch(() => [] as string[]);
  const found = dirEntries.filter((entry) => existsSync(join(skillsDir, entry, "SKILL.md"))).length;

  if (found > 0) {
    emit({ type: "check", name: `${found} project skills in .claude/skills`, ok: true });
    return;
  }
  if (process.env["HEDERA_SKILLS_DIR"] !== undefined) {
    emit({ type: "check", name: "skills from HEDERA_SKILLS_DIR", ok: true });
    return;
  }
  // Of the two documented install paths only `npx skills add` reaches the
  // generator: it writes into the project's .claude/skills, which
  // `settingSources: ["project"]` loads. The `/plugin install` flow installs at
  // user level, which that setting excludes — so the remedy says why, rather
  // than leaving someone who has the skills in their own session wondering.
  emit({
    type: "check",
    name: "no project skills — the agent works without Hedera knowledge, which is fine",
    ok: false,
    remedy:
      "for better output: npx skills add hedera-dev/hedera-skills\n" +
      "installing them as a Claude Code plugin instead puts them in your own settings, " +
      "which a run cannot read — it only loads what the project carries, so every " +
      "teammate gets the same ones.",
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
  const dirEntries = await readdir(browserCache()).catch(() => [] as string[]);
  if (dirEntries.some((entry) => entry.startsWith("chromium"))) {
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
  // Git only. This ran inside a Node process and asked whether Node was
  // installed, which cannot come back false.
  if (!(await exists("git", repoRoot))) throw new DoctorError("not on PATH: git");
  emit({ type: "check", name: "git", ok: true });
}

async function exists(binary: string, cwd: string): Promise<boolean> {
  const result = await runCommand({ run: `command -v ${binary}` }, cwd, 10_000);
  return result.code === 0;
}

/**
 * A repo is only worth generating into once it was already healthy, and the
 * proof uses the same code path an attempt will use — so the commands that
 * proved the repo healthy are exactly the commands the agent is later judged
 * against.
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
