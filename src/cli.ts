#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CONFIG_FILE, readConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { initialise } from "./init.js";
import { runLoop } from "./loop.js";
import { killTrackedChildren } from "./commands.js";
import { commitWork, createBranch, currentBranch, headCommit, repoRoot, switchBranch } from "./git.js";
import { lastRun } from "./resume.js";
import { Run, ensureExcluded, timestamp } from "./run.js";
import { type Timings, emit, subscribe } from "./events.js";
import { renderToFile, renderToJson } from "./render/json.js";
import { report } from "./render/report.js";
import { renderToTerminal } from "./render/terminal.js";
import { red } from "./style.js";

const USAGE = `usage: harness init [name] [--model NAME] [--yes]
       harness run --spec <path> [--max-attempts N] [--model NAME]
                          [--judge-model NAME] [--yes] [--json]
       harness report [run] [--full]

Run from inside the target repository.

  init [name]         set the project up: work out its commands, and draft
                      specs/<name>.md for you to fill in (default: feature)
  run --spec <path>   build the feature described by a spec
  report [run]        read a finished run: what it did, what the evaluator
                      checked, and whether to believe it (default: the latest)

  --spec <path>        the feature to build
  --max-attempts N    repair attempts before giving up (default 3)
  --model NAME        agent model: sonnet (default), opus, haiku, or a full id
  --judge-model NAME  model for EVALUATE only (default: the same as --model)
  --yes               skip the first-run command confirmation
  --json              one JSON object per line instead of the watchable output
  --review            stop to confirm the checks read from the spec
  --continue          carry on from the last run: its branch, and what it
                      ended up failing on
  --full              report: include both agents' full tool feeds`;

class UsageError extends Error {}

/**
 * What an interrupt needs in order to leave things tidy. Filled in as the run
 * acquires it, so a Ctrl-C before the branch exists still kills any children.
 */
interface Interruptible {
  repoRoot?: string;
  run?: Run;
  branch?: string;
  startedOn?: string;
  specInRepo?: string | undefined;
  /** Attempts that actually completed, so a cancelled run does not report zero. */
  attempts: number;
}

// ponytail: module-level, for the same reason events.ts is — a harness process
// is exactly one run, and a signal handler cannot be handed state it was not
// given. Per-run if a process ever hosts two.
const context: Interruptible = { attempts: 0 };
let interrupting = false;

/** A cancelled run has no per-stage total worth reporting; the renderer omits it. */
const NO_TIMINGS: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };

/**
 * Without this, Ctrl-C skips the `finally` blocks that stop the dev server and
 * restore your branch, leaving a held port and a dirty tree on a harness
 * branch — the exact state that makes the next run refuse to start. The
 * attempt is committed rather than discarded, because a clean tree is what
 * lets you run again.
 */
async function cancel(): Promise<never> {
  killTrackedChildren();

  const { repoRoot, run, startedOn, branch } = context;
  if (repoRoot !== undefined) {
    await commitWork(
      "harness: cancelled",
      repoRoot,
      context.specInRepo === undefined ? [] : [context.specInRepo],
    ).catch(() => null);
    if (startedOn !== undefined) await switchBranch(startedOn, repoRoot).catch(() => undefined);
  }
  if (run !== undefined) {
    await run
      .writeResult({ passed: false, cancelled: true, attempts: context.attempts, branch: branch ?? null })
      .catch(() => undefined);
    emit({
      type: "run:finished",
      passed: false,
      cancelled: true,
      attempts: context.attempts,
      branch: branch ?? null,
      timings: NO_TIMINGS,
      dir: run.dir,
    });
  }
  process.exit(130);
}

function onInterrupt(): void {
  if (interrupting) process.exit(130);
  interrupting = true;
  emit({ type: "note", level: "warn", text: "interrupted — cleaning up (Ctrl-C again to quit now)" });
  void cancel();
}

type Command = "init" | "run" | "report";

interface Options {
  command: Command;
  /** `init`'s optional name, becoming `specs/<name>.md`. */
  name: string;
  spec: string;
  maxAttempts: number;
  model: string;
  judgeModel: string;
  assumeYes: boolean;
  json: boolean;
  review: boolean;
  continue: boolean;
  full: boolean;
}

/** Pinned rather than inherited, so a run does not change meaning when the CLI's default moves. */
const DEFAULT_MODEL = process.env["HARNESS_MODEL"] ?? "sonnet";

/**
 * Who judges, when it should not be whoever generated.
 *
 * Judges are documented to over-reward their own model family, and this harness
 * runs one model for both halves — which is the shape a run of first-attempt
 * passes would take if leniency were the cause. A different family is not
 * reachable here: the agent is Claude Code and nothing else, so opus judging
 * sonnet is a different model on the same training distribution, not an
 * independent opinion. What this buys is a stronger or simply different judge,
 * and the ability to ask whether two of them agree — which is evidence where
 * there is currently none.
 *
 * Defaults to the generating model, because changing who judges by default
 * would quietly change what every run costs.
 */
const DEFAULT_JUDGE = process.env["HARNESS_JUDGE_MODEL"];

/**
 * Where a derived check should expect the app. The real URL is only known once
 * `serve` has answered, which is after the spec has been read — so a route
 * check is written against this and resolved against the live one.
 */
const APP_URL_HINT = "http://localhost:3000";

function parse(argv: string[]): Options {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") throw new UsageError(USAGE);
  if (command !== "run" && command !== "init" && command !== "report") {
    throw new UsageError(`unknown command "${command}"\n\n${USAGE}`);
  }

  let values;
  let positionals: string[] = [];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        spec: { type: "string" },
        "max-attempts": { type: "string", default: "3" },
        model: { type: "string", default: DEFAULT_MODEL },
        "judge-model": { type: "string", ...(DEFAULT_JUDGE === undefined ? {} : { default: DEFAULT_JUDGE }) },
        yes: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        review: { type: "boolean", default: false },
        continue: { type: "boolean", default: false },
        full: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${USAGE}`);
  }

  if (command === "run" && values.spec === undefined) {
    throw new UsageError(`--spec is required\n\n${USAGE}`);
  }

  const maxAttempts = Number(values["max-attempts"]);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new UsageError(`--max-attempts must be a positive integer`);
  }

  return {
    command,
    name: positionals[0] ?? "feature",
    spec: values.spec === undefined ? "" : resolve(values.spec),
    maxAttempts,
    model: values.model,
    judgeModel: values["judge-model"] ?? values.model,
    assumeYes: values.yes,
    json: values.json,
    review: values.review,
    continue: values.continue,
    full: values.full,
  };
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);

  if (options.command === "run") {
    await access(options.spec, constants.R_OK).catch(() => {
      throw new Error(`cannot read spec: ${options.spec}`);
    });
  }

  const root = await repoRoot(process.cwd());

  // Reading a finished run touches nothing: no run directory, no branch, no
  // clean-tree requirement. It is the one command that works on a repo in any
  // state, which is exactly the state you are in when you want it.
  if (options.command === "report") {
    await report({
      repoRoot: root,
      run: positionalRun(argv),
      full: options.full,
    });
    return 0;
  }

  context.repoRoot = root;
  await ensureExcluded(root);

  const stamp = timestamp();
  const run = await Run.create(root, stamp);
  const branch = `harness/${stamp}`;
  context.run = run;

  // Renderers attach before the first event, and the log one needs the run
  // directory — which is why `Run.create` comes first.
  renderToFile(run.dir);
  if (options.json) renderToJson();
  else renderToTerminal();
  // Read back off the stream rather than tracked alongside it, so an
  // interrupted run reports the attempts that actually completed.
  subscribe((event) => {
    if (event.type === "attempt:finished") context.attempts = event.attempt;
  });

  const startedOn = await currentBranch(root);
  context.startedOn = startedOn;
  const specInRepoPath = options.command === "run" ? insideRepo(root, options.spec) : undefined;
  emit({
    type: "run:started",
    command: options.command,
    stamp,
    repo: root,
    spec: options.command === "run" ? options.spec : undefined,
    specInRepo: specInRepoPath,
    from: startedOn,
    head: (await headCommit(root)).slice(0, 12),
    model: options.model,
    maxAttempts: options.maxAttempts,
  });

  // DOCTOR runs before the branch exists: harness.yaml describes the project,
  // so it is committed where the project lives, not on a throwaway run branch.
  const specInRepo = specInRepoPath;
  context.specInRepo = specInRepo;

  // The spec is read before anything is built, which is the point: a check
  // derived from it cannot have been shaped by what the app turned out to do.
  const specText = options.command === "run" ? await readFile(options.spec, "utf8") : undefined;
  const examined = await doctor({
    repoRoot: root,
    run,
    model: options.model,
    spec: specText,
    appUrlHint: APP_URL_HINT,
    review: options.review,
    specPath: specInRepo,
    assumeYes: options.assumeYes,
  });

  if (options.command === "init") {
    await initialise({ repoRoot: root, run, model: options.model, name: options.name });
    return 0;
  }

  // Continuing branches from the previous run's work rather than from your
  // branch, so a run that stopped at its last attempt is not started over.
  // `startedOn` was recorded before this, so the run still returns you home.
  const resuming = options.continue ? await lastRun(root, stamp) : null;
  if (resuming !== null) {
    await switchBranch(resuming.branch, root);
    emit({
      type: "note",
      level: "info",
      text:
        resuming.failures.length === 0
          ? `continuing ${resuming.stamp} from ${resuming.branch}`
          : `continuing ${resuming.stamp} — attempt ${resuming.attempt} ended on ` +
            `${resuming.failures.length} failure(s), which the next attempt starts from`,
    });
  }

  const config = await readConfig(root);
  if (config === null) throw new Error(`${CONFIG_FILE} went missing between checks`);
  const archivedSpec = await run.archiveSpec(options.spec);

  await createBranch(branch, root);
  context.branch = branch;
  emit({ type: "branch", branch });

  let result;
  try {
    result = await runLoop({
      config,
      repoRoot: root,
      run,
      specPath: archivedSpec,
      spec: await readFile(archivedSpec, "utf8"),
      branch,
      maxAttempts: options.maxAttempts,
      model: options.model,
      judgeModel: options.judgeModel,
      checks: examined.checks,
      continuing: resuming === null ? undefined : resuming,
      specInRepo,
    });
  } finally {
    // Back to the branch the run started from, so the next run branches from
    // the same base instead of stacking on this one — and so a run leaves your
    // working state where it found it. The work is on `branch`, named below.
    await switchBranch(startedOn, root).catch((error: Error) => {
      emit({ type: "note", level: "warn", text: `could not return to ${startedOn}: ${error.message}` });
    });
  }

  emit({
    type: "run:finished",
    passed: result.passed,
    cancelled: false,
    attempts: result.attempts,
    branch: result.branch,
    timings: result.timings,
    dir: run.dir,
  });
  return result.passed ? 0 : 1;
}

/** `harness report <run>` — the optional run id, which shares `init`'s positional slot. */
function positionalRun(argv: string[]): string | undefined {
  const [, ...rest] = argv;
  return rest.find((argument) => !argument.startsWith("--"));
}

/** The spec's repo-relative path, or undefined when it lives outside the repo. */
function insideRepo(root: string, spec: string): string | undefined {
  const path = relative(root, spec);
  return path === "" || path.startsWith("..") ? undefined : path;
}

process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error instanceof UsageError ? message : `${red("harness:")} ${message}`);
  process.exitCode = 1;
}
