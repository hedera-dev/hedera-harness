/**
 * The conversation with an agent: reading its half, and recording ours.
 *
 * Parsing only — what a tool call *was*. How it looks on a terminal belongs to
 * a renderer, and lives in `render/terminal.ts`.
 */
import { appendFile } from "node:fs/promises";

/**
 * Pulls the one line worth reporting out of an SDK message, or null when there
 * is nothing to say. Tool inputs vary by tool, so this reads whichever field
 * carries the subject and falls back to the tool name alone.
 */
export function describeMessage(message: unknown): { tool: string; argument: string } | null {
  const candidate = message as { type?: string; message?: { content?: unknown } };
  if (candidate.type !== "assistant" || !Array.isArray(candidate.message?.content)) return null;

  for (const block of candidate.message.content as Array<Record<string, unknown>>) {
    if (block["type"] !== "tool_use") continue;
    const name = typeof block["name"] === "string" ? block["name"] : "tool";
    return { tool: shortName(name), argument: subjectOf(block["input"]) };
  }
  return null;
}

/** `mcp__harness__submit_verdict` reads as `verdict` in a live feed. */
function shortName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

function subjectOf(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url", "prompt", "description"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "";
}

/** What an SDK `result` message says about the turn that just ended. */
export interface Ending {
  /** Turns the SDK counted, which is what `maxTurns` is enforced against. */
  turns: number;
  /** Cumulative for the session, so the last one wins rather than the sum. */
  costUsd: number | undefined;
  /** Set when the SDK stopped the agent itself, e.g. a turn limit. */
  failure: { reason: string; recoverable: boolean } | null;
}

/**
 * Reads a `result` message, or null for anything else.
 *
 * Two traps. Turns must be the SDK's count rather than a tally of assistant
 * messages, because that is what `maxTurns` is enforced against. And one
 * conversation can end twice — a background subagent finishing wakes it with a
 * `task-notification` — so turns accumulate across endings, while
 * `total_cost_usd` is already cumulative and must not.
 */
export function endingOf(message: unknown, maxTurns: number): Ending | null {
  const candidate = message as {
    type?: string;
    num_turns?: number;
    total_cost_usd?: number;
    is_error?: boolean;
    subtype?: string;
    result?: string;
  };
  if (candidate.type !== "result") return null;
  return {
    turns: candidate.num_turns ?? 0,
    costUsd: candidate.total_cost_usd,
    failure:
      candidate.is_error === true
        ? describeStop(candidate.subtype, maxTurns, candidate.result)
        : null,
  };
}

/**
 * Why the SDK stopped the agent, and whether asking again could get further.
 *
 * Only a turn limit is recoverable: the work was unfinished and another slice
 * finishes it. A spend cap is not — each pass is its own `query()` with its own
 * allowance, so retrying a budget breach spends the cap twice, which is the one
 * thing a spend cap exists to prevent. An execution error is not a bound at
 * all.
 */
function describeStop(
  subtype: string | undefined,
  maxTurns: number,
  said: string | undefined,
): { reason: string; recoverable: boolean } {
  if (subtype === "error_max_turns") {
    return { reason: `it used all ${maxTurns} of its turns`, recoverable: true };
  }
  if (subtype === "error_max_budget_usd") {
    return { reason: "it reached its spend limit", recoverable: false };
  }
  // Everything else: the subtype is a label and the payload is the reason. A
  // usage limit arrives as `subtype: "success"` with `is_error: true`, and
  // reporting the label alone produced "it stopped early (success)" while
  // "You've hit your session limit · resets 4:50pm" sat unread in the same
  // message.
  const told = said?.trim();
  return {
    reason: told !== undefined && told !== "" ? told : `it stopped early (${subtype ?? "error"})`,
    recoverable: false,
  };
}

/**
 * Records what the harness said, so a transcript is both halves.
 *
 * The SDK streams the agent's messages but not the prompt that started them,
 * so `generate.jsonl` and `evaluate.jsonl` held everything an agent did and
 * nothing it was asked. That gap is not academic: verifying that a corrected
 * nudge actually reached the model was impossible from the artifacts, leaving
 * only the model's behaviour to infer it from — in a tool whose claim is that
 * you need not infer.
 *
 * Marked with a `harness:` type so it cannot be mistaken for something the
 * agent said, and redacted, because a brief now carries a live key.
 */
export async function said(
  transcript: string,
  what: "prompt" | "nudge",
  text: string,
  secret?: string | undefined,
): Promise<void> {
  const entry = { type: `harness:${what}`, at: new Date().toISOString(), text: redact(text, secret) };
  await appendFile(transcript, `${JSON.stringify(entry)}\n`);
}

/**
 * Kept here rather than imported from `wallet.ts` so that recording a message
 * cannot depend on the thing it is protecting against. A value too short to be
 * a key would match half a transcript, so it is refused.
 */
function redact(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < 8) return text;
  return text.split(secret).join("«redacted»");
}
