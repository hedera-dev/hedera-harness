import { join } from "node:path";
import { type AttemptFailure, describeFailure } from "../failure.js";
import { cited } from "../evaluate.js";

/** What an attempt is told, so the next one can fix it. */
export interface Feedback {
  ok: boolean;
  failures: AttemptFailure[];
  /** Command output, carried to the repair prompt but not to `feedback.json`. */
  detail?: string;
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
export function repairPrompt(feedback: Feedback, artifacts: string): string {
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
 * evidence behind it.
 */
function pointers(failure: AttemptFailure, artifacts: string): string[] {
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
