/**
 * Everything a run has to say, as data.
 *
 * One rule earns the indirection: **events carry data, never formatted
 * strings.** A stage reports 43 turns and 30 tool calls; that this reads as
 * `done — 43 turns` is the renderer's job. An event carrying a sentence
 * reduces the JSON renderer to quoting the terminal one.
 */
import type { Command } from "./commands.js";
import type { AttemptFailure } from "./failure.js";

/** The four stages of the loop. Named `Phase` to leave `Stage` to the commands. */
export type Phase = "doctor" | "generate" | "test" | "evaluate";

/** Wall-clock per stage across a whole run. */
export interface Timings {
  generateMs: number;
  testMs: number;
  evaluateMs: number;
}

export type HarnessEvent =
  /** Once, first. What this run was pointed at. */
  | {
      type: "run:started";
      command: "run" | "init";
      stamp: string;
      repo: string;
      /** Absolute path, when the command is `run`. */
      spec?: string | undefined;
      /** Repo-relative, when the spec lives inside the repo. */
      specInRepo?: string | undefined;
      from: string;
      head: string;
      model: string;
      maxAttempts: number;
    }
  /** One of DOCTOR's preconditions. `ok: false` is a warning, not a failure — a failure throws. */
  | { type: "check"; name: string; ok: boolean; remedy?: string }
  | { type: "phase:started"; phase: Phase; attempt?: number | undefined; detail?: string | undefined }
  /**
   * `attempt` is absent for DOCTOR's baseline and present for every attempt
   * after it. Carried rather than inferred from position: the same code path
   * serves both, so a reader that works it out from the preceding
   * `phase:started` is correct only until an event is emitted between phases,
   * and then silently wrong.
   */
  | { type: "command:started"; name: string; command: Command; attempt?: number | undefined }
  | { type: "command:skipped"; name: string; reason: string; attempt?: number | undefined }
  /** Heartbeat from a long command: how long it has run, and its own last line. */
  | { type: "command:tick"; elapsedMs: number; line: string; attempt?: number | undefined }
  /** One tool call, by the agent working in `phase` on `attempt`. */
  | { type: "tool"; tool: string; argument: string; phase: Phase; attempt: number }
  | {
      type: "generate:finished";
      attempt: number;
      turns: number;
      toolCalls: number;
      /** Under subscription auth this is a list-price equivalent of tokens used, not money. */
      costUsd?: number | undefined;
      durationMs: number;
    }
  | {
      type: "evaluate:finished";
      attempt: number;
      verdict: "pass" | "fail" | "none";
      findings: number;
      /** Same caveat as generation's: a list-price equivalent, not money. */
      costUsd?: number | undefined;
      durationMs: number;
    }
  | { type: "committed"; attempt: number; sha: string | null }
  /** One claim the harness settled itself. `errored` is a warning, never a failure. */
  | {
      type: "check:settled";
      id: string;
      source: "declared" | "derived";
      state: "held" | "failed" | "errored";
      detail: string;
      /**
       * The spec line a derived check was read from. A derived failure appears
       * only in the report, so the quote has to travel with the event — it is
       * how a reader tells "my app is wrong" from "my spec said something I
       * did not mean".
       */
      because?: string | undefined;
      attempt: number;
    }
  | {
      type: "attempt:finished";
      attempt: number;
      passed: boolean;
      /** Failures that also failed the previous attempt — the signal that matters. */
      open: number;
      fixed: number;
      fresh: number;
      /** Fields, not sentences — a report groups by these and CI gates on them. */
      failures: AttemptFailure[];
    }
  | { type: "branch"; branch: string }
  /** What DOCTOR read out of the spec, before the app existed. */
  | { type: "derived"; checks: Array<{ id: string; because?: string | undefined }> }
  /** DOCTOR's proposed commands, before the operator confirms them. */
  | {
      type: "proposal";
      commands: Array<{ name: string; command: Command | null; note?: string | undefined }>;
    }
  /** Anything worth saying that is not one of the above. `warn` is for the unexpected-but-survivable. */
  | { type: "note"; level: "info" | "warn"; text: string; attempt?: number | undefined }
  | {
      type: "run:finished";
      passed: boolean;
      cancelled: boolean;
      attempts: number;
      branch: string | null;
      timings: Timings;
      /** The run directory, so a renderer can point at the artifacts. */
      dir: string;
    }
  /** `init` wrote a spec skeleton. */
  | { type: "spec:written"; path: string; tailored: boolean };

export type Listener = (event: HarnessEvent) => void;

// ponytail: module-level, because a harness process is exactly one run — the
// alternative is threading an emitter through every function in the codebase
// to serve a second run that will never exist. `reset` keeps tests honest.
const listeners = new Set<Listener>();

export function emit(event: HarnessEvent): void {
  for (const listener of listeners) listener(event);
}

/** Returns the function that detaches it again. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drops every renderer. For tests, so one case cannot leak into the next. */
export function reset(): void {
  listeners.clear();
}

/** Collects events for the duration of a test, and detaches itself. */
export function collect(): { events: HarnessEvent[]; stop: () => void } {
  const events: HarnessEvent[] = [];
  const stop = subscribe((event) => events.push(event));
  return { events, stop };
}
