import { join, relative } from "node:path";
import { writeFile } from "node:fs/promises";
import type { HarnessConfig } from "./config.js";
import type { Check } from "./checks.js";
import { type Outcome, cited, evaluate } from "./evaluate.js";
import { generate } from "./generate.js";
import { commitWork } from "./git.js";
import { type Timings, emit } from "./events.js";
import { type AttemptFailure, describeFailure, fromCheck, fromStage, fromVerdict } from "./failure.js";
import type { Run } from "./run.js";
import { startServer } from "./serve.js";
import { type StageFailure, runStages } from "./test.js";

/** How much of a failing command's output the repair prompt carries. */
const OUTPUT_TAIL = 4_000;

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
  /** Read from the spec at DOCTOR, pinned for the run, settled every attempt. */
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
interface Feedback {
  ok: boolean;
  failures: AttemptFailure[];
  /** Command output, carried to the repair prompt but not to `feedback.json`. */
  detail?: string;
}

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
    const generated = await build({ repoRoot, run, prompt, attempt, resume: session, model: options.model });
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

  // A claim the harness settled and found untrue is a reason the attempt did
  // not pass, exactly like one the judge formed. It reaches the repair prompt
  // and the open/fixed/new tally by the same route.
  const measured = outcome.checks
    .filter((result) => result.state === "failed" && result.check.source === "declared")
    .map(fromCheck);
  return { ok: false, failures: [...measured, ...fromVerdict(outcome.verdict)] };
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

/**
 * What the agent is told went wrong.
 *
 * A stage failure carries the command's own output, so it explains itself. A
 * verdict failure is one sentence from someone who watched the app in a browser
 * — so it gets the evidence too, by a path the agent can actually open. The
 * evaluator saves screenshots, page snapshots and saved responses, all of them
 * readable, and citing them by bare filename made them unfindable.
 */
function repairPrompt(feedback: Feedback, artifacts: string): string {
  return [
    "That attempt did not pass. What went wrong:",
    "",
    ...feedback.failures.flatMap((failure) => [
      `- ${describeFailure(failure)}`,
      ...pointers(failure, artifacts),
    ]),
    feedback.detail === undefined ? "" : `\n${feedback.detail}`,
    "",
    "Fix it, then stop. Do not start the dev server or run the checks yourself —",
    "they run automatically once you are done.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Where to look. A stage failure points at its own output, a judged one at the
 * evidence behind it, and a measured one at nothing — the harness read the
 * chain itself, so the claim and its result are the whole story.
 */
function pointers(failure: AttemptFailure, artifacts: string): string[] {
  if (failure.kind === "check") return [];
  if (failure.kind === "verdict") {
    return failure.evidence.map((item) => `  ${located(item, artifacts)}`);
  }
  return [`  full output: ${join(artifacts, `${failure.stage}.txt`)}`];
}

/**
 * Evidence is a file the evaluator saved, or a URL it read. Only the first
 * needs a path, and it is reduced by the same function that validated it — so
 * a citation cannot pass the check in one spelling and be built into a path in
 * another, which is how `evidence/evidence/shot.png` happened.
 */
function located(evidence: string, artifacts: string): string {
  const name = cited(evidence);
  return name === evidence && /^https?:\/\//.test(evidence)
    ? evidence
    : join(artifacts, "evidence", name);
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
