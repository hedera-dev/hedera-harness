import { createHash } from "node:crypto";
import { type Command, describe } from "./commands.js";
import type { Verdict } from "./evaluate.js";
import type { Stage, StageFailure } from "./test.js";

/**
 * One reason an attempt did not pass, as fields rather than a sentence.
 *
 * A pre-glued string forces every reader to regex back out the fields it was
 * built from, and this is what a report groups by, what CI would gate on and
 * what the harness hashes. Type, identity and prose live together because all
 * three answer one question: what counts as the same failure again.
 */
export type AttemptFailure =
  /** A command the harness ran and that exited non-zero. No agent involved. */
  | {
      kind: "stage";
      /** Stable across attempts; see `identify`. */
      id: string;
      stage: Stage;
      command: Command;
      code: number | null;
      timedOut: boolean;
      /** The bound the command ran under, so the reason it was killed is legible. */
      timeoutMs: number;
      /** The first line that looked like an error, normalised. What the hash is built from. */
      error: string;
      /** Run-relative path to the full output, e.g. `attempt-2/build.txt`. */
      artifact: string;
    }
  /** Something the blind evaluator could not do in the running app. */
  | {
      kind: "verdict";
      id: string;
      /** A bare locator — a route or a selector. The only part that is hashed. */
      where: string;
      what: string;
      /** Filenames under the attempt's `evidence/`, or mirror node URLs. */
      evidence: string[];
    };

export function fromStage(failure: StageFailure): AttemptFailure {
  const error = firstError(failure.output);
  return {
    kind: "stage",
    id: identity(failure.stage, error),
    stage: failure.stage,
    command: failure.command,
    code: failure.code,
    timedOut: failure.timedOut,
    timeoutMs: failure.timeoutMs,
    error,
    artifact: failure.artifact,
  };
}

export function fromVerdict(verdict: Verdict): AttemptFailure[] {
  return verdict.failures.map((failure) => ({
    kind: "verdict" as const,
    // Hashed on `where` alone. `what` is prose from an evaluator that is fresh
    // every attempt, so it is worded differently each time — hashing it would
    // make one recurring bug look like a new one, which is exactly the signal
    // this exists to produce.
    id: identity(failure.where),
    where: failure.where,
    what: failure.what,
    evidence: failure.evidence,
  }));
}

/** One line, for a person: a terminal row, a repair prompt, an error message. */
export function describeFailure(failure: AttemptFailure): string {
  if (failure.kind === "verdict") {
    return `${failure.where}: ${failure.what} [${failure.evidence.join(", ")}]`;
  }
  // The bound belongs in the sentence: "timed out" alone does not tell the
  // agent whether its command hung or was merely slow, and that decides
  // whether the fix is to make it faster or to stop it blocking.
  const what = failure.timedOut
    ? `timed out after ${Math.round(failure.timeoutMs / 60_000)} minutes`
    : `exited ${failure.code}`;
  return `${failure.stage}: \`${describe(failure.command)}\` ${what}`;
}

/**
 * First line that looks like an error, with digits flattened — so a line
 * number moving, or a differing duration, does not make a recurring failure
 * read as a new one.
 */
function firstError(output: string): string {
  const line = output
    .split("\n")
    .find((candidate) => /\b(error|failed|cannot|not found|exception)\b/i.test(candidate));
  return (line ?? output.split("\n")[0] ?? "").trim().replace(/\d+/g, "N").slice(0, 200);
}

function identity(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}
