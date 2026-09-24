import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe } from "../commands.js";
import type { HarnessEvent } from "../events.js";
import { describeFailure } from "../failure.js";
import { ARTIFACT_DIR } from "../run.js";
import {
  bold,
  clip,
  describeTimings,
  dim,
  formatDuration,
  frame,
  green,
  red,
  verdict,
  yellow,
} from "../style.js";

const EVENTS_FILE = "events.jsonl";

/** Enough to see what kind of evidence there is; the rest is a directory listing. */
const EVIDENCE_SHOWN = 8;

export class ReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportError";
  }
}

export interface ReportOptions {
  repoRoot: string;
  /** A run's timestamp. Omitted means the most recent. */
  run?: string | undefined;
  /** Include both agents' full tool feeds. */
  full: boolean;
}

/**
 * Reads a finished run back.
 *
 * Not to replay it, but to make its adjudication checkable: verifying the
 * first real verdict by hand took four `jq` commands, and a guarantee that
 * expensive to check is one people stop checking. Hence the weight on what the
 * evaluator did, what it saved, and what the live output passed over — that
 * run needed two evaluation passes and the summary never said so.
 */
export async function report(options: ReportOptions): Promise<void> {
  const dir = await locate(options);
  const events = await load(dir);

  const started = find(events, "run:started");
  const finished = find(events, "run:finished");
  const byAttempt = group(events);

  console.log(`\n${bold("report")}  ${dim(started?.stamp ?? dir)}`);
  summary(events, started, finished);

  // A warning that belongs to no attempt — an interrupt, a branch the run could
  // not get back to. Attributing events properly means these no longer land in
  // whichever attempt happened to be open, so they need somewhere of their own
  // rather than disappearing.
  for (const note of events) {
    if (note.type !== "note" || note.level !== "warn" || note.attempt !== undefined) continue;
    console.log(`\n${yellow("!")} ${dim(note.text.trim())}`);
  }
  for (const [attempt, mine] of byAttempt) {
    await section(dir, events, attempt, mine, options.full);
  }
  next(dir, finished);
}

function summary(
  events: HarnessEvent[],
  started: Extract<HarnessEvent, { type: "run:started" }> | undefined,
  finished: Extract<HarnessEvent, { type: "run:finished" }> | undefined,
): void {
  const verdict =
    finished === undefined
      ? yellow("UNFINISHED")
      : finished.cancelled
        ? yellow("CANCELLED")
        : finished.passed
          ? green("PASSED")
          : red("FAILED");

  const lines = [`${verdict} ${dim(`after ${finished?.attempts ?? "?"} attempt(s)`)}`];
  if (finished !== undefined && !finished.cancelled) {
    lines.push(dim(describeTimings(finished.timings)));
  }
  // The first thing a run could not tell you: what it cost in total. Generation
  // reported its own spend and evaluation reported none, so the number on
  // screen was always the smaller half.
  const spend = cost(events);
  if (spend !== null) {
    // Runs from before evaluation reported its spend would otherwise show the
    // generator's half and call it the total, which is how I came to quote a
    // $1.26 run at $0.70.
    lines.push(dim(`~$${spend.total.toFixed(2)} of tokens${spend.partial ? " (generation only)" : " in total"}`));
  }
  console.log(`\n${frame(lines)}`);

  if (started === undefined) return;
  console.log(`\n${dim("repo  ")} ${started.repo}`);
  console.log(`${dim("spec  ")} ${started.specInRepo ?? started.spec ?? "—"}`);
  console.log(`${dim("from  ")} ${started.from} ${dim(`at ${started.head}`)}`);
  console.log(`${dim("model ")} ${started.model}`);
}

/** One attempt, in the order it happened: build it, test it, judge it. */
async function section(
  dir: string,
  events: HarnessEvent[],
  attempt: number,
  mine: HarnessEvent[],
  full: boolean,
): Promise<void> {
  const outcome = mine.find((event) => event.type === "attempt:finished");
  const label = outcome === undefined ? yellow("unfinished") : outcome.passed ? green("passed") : red("failed");
  console.log(`\n${bold(`ATTEMPT ${attempt}`)}  ${label}`);

  const generated = mine.find((event) => event.type === "generate:finished");
  if (generated !== undefined) {
    const spend = generated.costUsd === undefined ? "" : ` · ~$${generated.costUsd.toFixed(2)}`;
    console.log(
      `  ${"generate".padEnd(9)} ${dim(formatDuration(generated.durationMs).padStart(6))}  ` +
        dim(`${generated.turns} turns · ${generated.toolCalls} tool calls${spend}`),
    );
  }

  const commands = mine.filter(
    (event) => event.type === "command:started" || event.type === "command:skipped",
  );
  if (commands.length > 0) {
    const shown = commands.map((event) =>
      event.type === "command:skipped"
        ? `${event.name} (skipped)`
        : `${event.name}: ${describe(event.command)}`,
    );
    console.log(`  ${"test".padEnd(9)} ${dim("      ")}  ${dim(shown.join(" · "))}`);
  }

  const evaluations = mine.filter((event) => event.type === "evaluate:finished");
  if (evaluations.length > 0) {
    const total = evaluations.reduce((sum, event) => sum + event.durationMs, 0);
    const last = evaluations[evaluations.length - 1];
    console.log(
      `  ${"evaluate".padEnd(9)} ${dim(formatDuration(total).padStart(6))}  ` +
        `${verdictOf(last)}${dim(evaluations.length > 1 ? ` · ${evaluations.length} passes` : "")}`,
    );
  }

  // The headline of the whole verification story: the evaluator answered pass,
  // and a claim it declared itself did not hold. Nothing else in a run is worth
  // seeing sooner.
  const judged = evaluations[evaluations.length - 1];
  if (judged?.verdict === "pass" && outcome !== undefined && !outcome.passed) {
    console.log(
      `  ${red("✗")} ${dim("the harness overrode this — a claim the evaluator made did not hold")}`,
    );
  }

  settled(mine);

  // Anomalies the live output slides past. The one real occurrence — an
  // evaluator that ended its turn without answering — was invisible in a
  // summary that said "PASSED after 1 attempt".
  for (const note of mine.filter((event) => event.type === "note")) {
    console.log(`  ${yellow("!")} ${dim(note.text)}`);
  }

  if (outcome !== undefined && (!outcome.passed || outcome.fixed > 0)) {
    const earlier = seenBefore(events, attempt);
    console.log(
      `\n  ${dim(`${outcome.open} open · ${outcome.fixed} fixed · ${outcome.fresh} new`)}`,
    );
    for (const failure of outcome.failures) {
      const again = earlier.has(failure.id) ? dim("  (still open)") : "";
      // Two words, and only two: whether the harness looked, or the evaluator
      // formed an opinion. A reader needs to know how certain a finding is.
      const how = failure.kind === "verdict" ? "judged" : "measured";
      console.log(`    ${dim(how.padEnd(8))} ${describeFailure(failure)}${again}`);
    }
  }

  await audit(dir, mine, attempt, full);
}

/**
 * Claims the harness settled itself.
 *
 * The ones that held are a count, not a list — by the tenth run nobody rereads
 * what was fine. What earns a line is a claim that could not be read at all:
 * those are warnings rather than failures, so they appear nowhere else, and an
 * unreadable check usually means the check was wrong rather than the app.
 */
function settled(mine: HarnessEvent[]): void {
  const results = mine.filter((event) => event.type === "check:settled");
  if (results.length === 0) return;

  const counted = (state: string) => results.filter((event) => event.state === state).length;
  const parts = [
    `${counted("held")} held`,
    ...(counted("failed") > 0 ? [`${counted("failed")} failed`] : []),
    ...(counted("errored") > 0 ? [`${counted("errored")} unreadable`] : []),
  ];
  console.log(`  ${"checks".padEnd(9)} ${dim("      ")}  ${dim(parts.join(" · "))}`);

  for (const event of results) {
    if (event.state !== "errored") continue;
    console.log(`    ${yellow("!")} ${dim(`${event.id} — ${event.detail}`)}`);
  }
}

/**
 * What the evaluator actually did, and what it left behind. This is the part
 * that makes a verdict something you can check rather than something you accept.
 */
async function audit(
  dir: string,
  mine: HarnessEvent[],
  attempt: number,
  full: boolean,
): Promise<void> {
  // Split by whose calls they were. The generator's count is already on its own
  // line; what belongs here is the judge's work, because that is the part a
  // verdict rests on.
  const byPhase = tools(mine);
  const judged = byPhase.get("evaluate") ?? [];
  const files = await readdir(join(dir, `attempt-${attempt}`, "evidence")).catch(() => [] as string[]);
  if (judged.length === 0 && files.length === 0) return;

  if (files.length > 0) {
    const images = files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).length;
    console.log(
      `\n  ${dim("evidence")}  attempt-${attempt}/evidence/  ` +
        dim(`${files.length} files${images > 0 ? `, ${images} screenshots` : ""}`),
    );
    for (const name of files.slice(0, EVIDENCE_SHOWN)) console.log(`    ${dim(name)}`);
    if (files.length > EVIDENCE_SHOWN) {
      console.log(`    ${dim(`… and ${files.length - EVIDENCE_SHOWN} more`)}`);
    }
  }

  if (!full) {
    if (judged.length > 0) {
      console.log(
        `\n  ${dim(`the evaluator made ${judged.length} call${judged.length === 1 ? "" : "s"} — ` +
          `harness report --full to see them`)}`,
      );
    }
    return;
  }
  for (const [phase, calls] of byPhase) {
    console.log(`\n  ${dim(`${phase} — ${calls.length} calls`)}`);
    for (const step of calls) {
      console.log(`    ${step.tool.padEnd(9)} ${dim(clip(step.argument))}`);
    }
  }
}

/** Tool calls split by the phase that made them, which each call now states. */
function tools(mine: HarnessEvent[]): Map<string, Array<Extract<HarnessEvent, { type: "tool" }>>> {
  const byPhase = new Map<string, Array<Extract<HarnessEvent, { type: "tool" }>>>();
  for (const event of mine) {
    if (event.type !== "tool") continue;
    byPhase.set(event.phase, [...(byPhase.get(event.phase) ?? []), event]);
  }
  return byPhase;
}

function next(dir: string, finished: Extract<HarnessEvent, { type: "run:finished" }> | undefined): void {
  console.log("");
  if (finished?.branch != null) {
    console.log(dim("the work is on a branch:"));
    console.log(`  git switch ${finished.branch}`);
  }
  console.log(dim(`  open ${dir}`));
  console.log("");
}

function verdictOf(event: Extract<HarnessEvent, { type: "evaluate:finished" }> | undefined): string {
  return event === undefined ? dim("—") : verdict(event.verdict, event.findings);
}

/** Failure ids from every earlier attempt, so a repeat can be marked as one. */
function seenBefore(events: HarnessEvent[], attempt: number): Set<string> {
  const ids = events
    .filter((event) => event.type === "attempt:finished" && event.attempt < attempt)
    .flatMap((event) => (event.type === "attempt:finished" ? event.failures : []))
    .map((failure) => failure.id);
  return new Set(ids);
}

/**
 * Generation reports the spend of a whole session; each evaluation pass reports
 * its own. Summing across the two is the only way to a run's real total.
 */
function cost(events: HarnessEvent[]): { total: number; partial: boolean } | null {
  const spending = events.filter(
    (event): event is Extract<HarnessEvent, { type: "generate:finished" | "evaluate:finished" }> =>
      event.type === "generate:finished" || event.type === "evaluate:finished",
  );
  const amounts = spending.map((event) => event.costUsd);
  const known = amounts.filter((amount): amount is number => amount !== undefined);
  if (known.length === 0) return null;
  return {
    total: known.reduce((sum, amount) => sum + amount, 0),
    partial: known.length < amounts.length,
  };
}

/**
 * Splits the stream by attempt, reading the attempt off each event.
 *
 * This used to be positional — bucket everything after a `phase:started` with
 * that phase's attempt — which was right until any event was emitted between
 * phases, and then silently wrong: nothing errors, nothing fails, the report is
 * just quietly attributed to the wrong attempt. Events carry it now.
 */
function group(events: HarnessEvent[]): Map<number, HarnessEvent[]> {
  const byAttempt = new Map<number, HarnessEvent[]>();
  for (const event of events) {
    const attempt = "attempt" in event ? event.attempt : undefined;
    if (attempt === undefined) continue;
    byAttempt.set(attempt, [...(byAttempt.get(attempt) ?? []), event]);
  }
  return new Map([...byAttempt].sort(([a], [b]) => a - b));
}

function find<T extends HarnessEvent["type"]>(
  events: HarnessEvent[],
  type: T,
): Extract<HarnessEvent, { type: T }> | undefined {
  return events.find((event): event is Extract<HarnessEvent, { type: T }> => event.type === type);
}

async function load(dir: string): Promise<HarnessEvent[]> {
  const source = await readFile(join(dir, EVENTS_FILE), "utf8").catch(() => null);
  if (source === null) {
    throw new ReportError(
      `${join(dir, EVENTS_FILE)} is not there. Runs from before the harness recorded ` +
        `events cannot be reported on — their artifacts are still in ${dir}.`,
    );
  }
  return source
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as HarnessEvent);
}

async function locate(options: ReportOptions): Promise<string> {
  const runs = join(options.repoRoot, ARTIFACT_DIR, "runs");
  if (options.run !== undefined) return join(runs, options.run);

  const entries = await readdir(runs).catch(() => [] as string[]);
  const latest = entries.sort().pop();
  if (latest === undefined) throw new ReportError(`no runs yet in ${runs}`);
  return join(runs, latest);
}
