import { join, relative } from "node:path";
import { writeFile } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import type { Check } from "./checks.js";
import { type Outcome, evaluate } from "./evaluate.js";
import { type Feedback, repairPrompt } from "./prompts/repair.js";
import { generate } from "./generate.js";
import { commitWork } from "./git.js";
import { type Timings, emit } from "./events.js";
import { type AttemptFailure, fromStage, fromVerdict } from "./failure.js";
import type { Run } from "./run.js";
import { startServer } from "./serve.js";
import { type StageFailure, runStages } from "./test.js";

/** How much of a failing command's output the repair prompt carries. */
const OUTPUT_TAIL = 4_000;

/**
 * How long a whole run may take before it stops starting new attempts.
 *
 * Every stage was bounded and the run was not, so the bounds multiplied: three
 * attempts of generation (60), commands (62) and evaluation (45 plus a nudge)
 * is over ten hours, with nothing but Ctrl-C in the way. Nobody chose ten
 * hours; it was the product of five numbers each chosen for its own reasons.
 */
const RUN_BUDGET_MS = 4 * 60 * 60_000;

export interface LoopOptions {
  config: HarnessConfig;
  repoRoot: string;
  run: Run;
  specPath: string;
  spec: string;
  branch: string;
  maxAttempts: number;
  model: string;
  /** Who judges. The same as `model` unless asked otherwise. */
  judgeModel: string;
  /** Unset means no spend ceiling. Bounds each agent call, not the run. */
  maxSpendUsd?: number | undefined;
  /** Read from the spec at DOCTOR, pinned for the run, verified by the judge every attempt. */
  checks: Check[];
  /**
   * Failures a previous run ended on. The first attempt starts as a repair of
   * those rather than as a fresh reading of the spec — the code is already on
   * the branch, so asking for it again would be asking for work that exists.
   */
  continuing?: { failures: AttemptFailure[]; artifacts: string } | undefined;
  /** Repo-relative spec path, when it lives in the repo. Never committed as work. */
  specInRepo?: string | undefined;
  /**
   * The two calls that need an agent. Injectable because the decisions this
   * loop makes across attempts — what repeated, when to abandon the session,
   * when to stop — cannot otherwise be exercised without paying for a model to
   * fail on cue. Everything else in an attempt runs for real.
   */
  agents?: Agents;
}

export interface Agents {
  generate: typeof generate;
  evaluate: typeof evaluate;
}

export interface LoopResult {
  passed: boolean;
  attempts: number;
  branch: string;
  /** Wall-clock per stage across the whole run, so the summary says where time went. */
  timings: Timings;
}

export type { Timings };

/** What an attempt failed on, in the shape the diagram uses for `feedback.json`. */
/** One attempt's outcome, as recorded in `result.json`. */
export interface Attempt {
  attempt: number;
  passed: boolean;
  failures: AttemptFailure[];
}

export class AbortRun extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortRun";
  }
}

/**
 * GENERATE → TEST → EVALUATE, repairing until the spec is met or the budget
 * is spent. The agent decides how to fix things; this decides whether it did.
 */
export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const { repoRoot, run, maxAttempts } = options;
  const build = options.agents?.generate ?? generate;

  const timings: Timings = { generateMs: 0, testMs: 0, evaluateMs: 0 };
  const startedAt = Date.now();
  // Recorded once: what the agent could reach. A run that behaves differently
  // from another is usually a different skill set, and this is the record of it.
  let skills: string[] = [];
  let prompt =
    options.continuing !== undefined && options.continuing.failures.length > 0
      ? repairPrompt({ ok: false, failures: options.continuing.failures }, options.continuing.artifacts)
      : options.spec;
  let session: string | undefined;
  let previous: Set<string> = new Set();
  // Kept for `result.json`: which failures each attempt produced, so a finished
  // run says whether the agent converged rather than only how many tries it had.
  const history: Attempt[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Checked between attempts, never inside one: a deadline that killed work
    // in flight would throw away a generation already paid for. So the real
    // ceiling is this plus one attempt, which is the point — it stops the next
    // one starting rather than interrupting this one.
    const spent = Date.now() - startedAt;
    if (attempt > 1 && spent > RUN_BUDGET_MS) {
      emit({
        type: "note",
        level: "warn",
        text:
          `stopping after ${attempt - 1} attempt(s): ${Math.round(spent / 60_000)} minutes is ` +
          `past the ${RUN_BUDGET_MS / 60_000}-minute budget for a run. The branch has the work so far, ` +
          `and --continue picks it up.`,
      });
      break;
    }

    const generated = await build({
      repoRoot,
      run,
      prompt,
      attempt,
      resume: session,
      model: options.model,
      maxSpendUsd: options.maxSpendUsd,
    });
    session = generated.sessionId;
    timings.generateMs += generated.durationMs;
    if (skills.length === 0) skills = generated.skills;

    const feedback = await assess(options, attempt, timings);
    history.push({ attempt, passed: feedback.ok, failures: feedback.failures });
    await writeFeedback(run, attempt, feedback);

    if (feedback.ok) {
      report(attempt, feedback, previous);
      await writeResult(run, { passed: true, attempts: attempt, branch: options.branch, timings, skills, history });
      return { passed: true, attempts: attempt, branch: options.branch, timings };
    }

    const repeated = report(attempt, feedback, previous);
    if (attempt === maxAttempts) break;

    // A failure that survived an attempt means the resumed conversation is
    // circling it. Dropping the session is the only way out of a line of
    // reasoning the agent has already committed to.
    if (repeated) {
      session = undefined;
      emit({
        type: "note",
        level: "warn",
        text: `attempt ${attempt + 1} starts a fresh session — same failure twice`,
        attempt,
      });
    }

    previous = new Set(feedback.failures.map((failure) => failure.id));
    prompt = repairPrompt(feedback, join(relative(repoRoot, run.dir), `attempt-${attempt}`));
  }

  await writeResult(run, { passed: false, attempts: history.length, branch: options.branch, timings, skills, history });
  return { passed: false, attempts: history.length, branch: options.branch, timings };
}

/**
 * TEST first, then EVALUATE only if it passed — a failing build never pays for
 * a browser. The attempt is committed once TEST is green, so the code the
 * evaluator judges is the code on the branch.
 */
async function assess(options: LoopOptions, attempt: number, timings: Timings): Promise<Feedback> {
  const { config, repoRoot, run } = options;

  emit({ type: "phase:started", phase: "test", attempt });
  const testStarted = Date.now();
  const failure = await runStages({ config, repoRoot, run, prefix: `attempt-${attempt}`, attempt });
  timings.testMs += Date.now() - testStarted;

  // Every attempt is committed, passing or not. A failing attempt left
  // uncommitted used to lock the harness out of itself: the next run hit
  // DOCTOR's clean-tree check and refused, with the cleanup left to you.
  // It is also the change you most want to read after a failure.
  const outcome = failure === null ? "passed tests" : `failed ${failure.stage}`;
  const commit = await commitWork(
    `harness: attempt ${attempt} (${outcome})`,
    repoRoot,
    options.specInRepo === undefined ? [] : [options.specInRepo],
  );
  emit({ type: "committed", attempt, sha: commit });

  if (failure !== null) return stageFeedback(failure);

  const judge = options.agents?.evaluate ?? evaluate;
  const server = await startServer(config.serve, repoRoot);
  const evaluateStarted = Date.now();
  try {
    return verdictFeedback(
      await judge({
        repoRoot,
        run,
        checks: options.checks,
        specPath: options.specPath,
        attempt,
        appUrl: server.url,
        model: options.judgeModel,
        maxSpendUsd: options.maxSpendUsd,
      }),
    );
  } finally {
    timings.evaluateMs += Date.now() - evaluateStarted;
    await server.stop();
  }
}

function stageFeedback(failure: StageFailure): Feedback {
  return {
    ok: false,
    failures: [fromStage(failure)],
    detail: failure.output.slice(-OUTPUT_TAIL),
  };
}

function verdictFeedback(outcome: Outcome): Feedback {
  if (outcome.type !== "verdict") throw new AbortRun(outcome.reason);
  if (outcome.verdict.pass) return { ok: true, failures: [] };
  return { ok: false, failures: fromVerdict(outcome.verdict) };
}

/**
 * Two attempts failing the same way is the signal that matters — it separates
 * an agent converging from one trading one failure for another.
 */
function report(attempt: number, feedback: Feedback, previous: Set<string>): boolean {
  // A passing attempt goes through the same arithmetic as any other. It used to
  // take a shortcut that reported zeros, which meant the one attempt that
  // actually resolved everything was the only one that never said what it had
  // fixed — the convergence story missing its ending.
  const now = feedback.failures.map((failure) => failure.id);
  const open = now.filter((id) => previous.has(id));
  const fixed = [...previous].filter((id) => !now.includes(id));

  emit({
    type: "attempt:finished",
    attempt,
    passed: feedback.ok,
    open: open.length,
    fixed: fixed.length,
    fresh: now.length - open.length,
    failures: feedback.failures,
  });
  return open.length > 0;
}

async function writeFeedback(run: Run, attempt: number, feedback: Feedback): Promise<void> {
  const body = { ok: feedback.ok, failures: feedback.failures };
  await writeFile(
    await run.path(`attempt-${attempt}`, "feedback.json"),
    `${JSON.stringify(body, null, 2)}\n`,
  );
}

async function writeResult(
  run: Run,
  result: {
    passed: boolean;
    attempts: number;
    branch: string;
    timings: Timings;
    skills: string[];
    history: Attempt[];
  },
): Promise<void> {
  await run.writeResult(result);
}
