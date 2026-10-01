/**
 * Checks read out of the spec, before the app exists.
 *
 * The judge receives these as a checklist it must account for, rather than as
 * claims it chose — a judge picking its own tests in the same breath as its
 * verdict picks ones that agree. Running before anything is built is what
 * guarantees it: nothing about the app can shape them.
 *
 * So this reads the spec and nothing else. No repo access, the text inline in
 * the prompt; a pass that could read the code would derive from the
 * implementation instead.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { confirm } from "./ask.js";
import { CHECKS_FILE, brief } from "./prompts/derive.js";
import { type Check, locate } from "./checks.js";
import { emit } from "./events.js";

/** Bounded: reading one document and answering once. */
const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 8;

export class DeriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeriveError";
  }
}

/**
 * Ran, or did not. A checklist empty because the spec is all judgement and one
 * empty because the derivation broke are opposite facts, and only the second
 * should stop a run.
 */
export type Derived = { checks: Check[]; dropped: number } | { failed: string };

export interface DeriveOptions {
  /** The spec's text. Checks are read from it before anything is built. */
  spec: string;
  /** Where the app will run, for the routes a derived check names. */
  model: string;
  /** Stop and confirm the derived checks rather than showing them and going on. */
  review: boolean;
  /** Answer the review confirmation without asking. */
  assumeYes: boolean;
}

/**
 * The phase between DOCTOR and GENERATE. Its own step, not part of DOCTOR,
 * because the whole property of these checks is that they exist before the
 * app does — nothing about the app can shape them — and because DOCTOR is
 * deterministic while this is the one pre-generation step that asks a model.
 *
 * Shown rather than asked about: whether a check says what you meant is
 * usually only visible once it has run. `--review` stops for approval.
 */
export async function deriveChecks(options: DeriveOptions): Promise<Check[]> {
  emit({ type: "phase:started", phase: "derive" });
  const derived = await derive(options.spec, options.model);

  // Failing here costs three minutes and nothing else: no generation has run,
  // no evaluation has been paid for. Continuing would cost a whole run and give
  // back a pass that nothing mechanical stood behind — and would look exactly
  // like a run where the spec simply had nothing to settle.
  if ("failed" in derived) {
    throw new DeriveError(
      `could not read checks from the spec: ${derived.failed}. ` +
        "Nothing has been generated yet, so this costs only the time to try again.",
    );
  }

  // Emitted even at zero. A checklist of none is a fact about the spec worth
  // seeing, and the only way to tell it apart from the failure above.
  emit({ type: "derived", checks: derived.checks, dropped: derived.dropped });

  if (derived.checks.length > 0 && options.review) {
    await confirm(
      "Use these?",
      options.assumeYes,
      "declined — edit the spec and run again.",
    );
  }
  return derived.checks;
}

/** Derives what a judge can verify by reading a value, from the spec's words. */
export async function derive(spec: string, model: string): Promise<Derived> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-derive-"));
  const target = join(workspace, CHECKS_FILE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const conversation = query({
      prompt: brief(spec, target),
      options: {
        model,
        // `Write` and nothing else. Not a convenience: with no Read, Glob or
        // Grep there is no way to reach the repo, so a check still cannot be
        // formed from the implementation — which is the whole property this
        // phase buys. The file is the answer, so that is all it needs.
        allowedTools: ["Write"],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: MAX_TURNS,
        abortController: controller,
        systemPrompt:
          "You turn a written specification into claims a judge can verify by " +
          "reading a value. You answer by writing one JSON file and nothing else.",
      },
    });
    for await (const _ of conversation) {
      // Drained; the checklist arrives on disk.
    }
    // The file is the answer, so a conversation that ended without one has not
    // answered — whatever it said on the way.
  } catch (error) {
    const why = controller.signal.aborted
      ? `it did not finish within ${TIMEOUT_MS / 60_000} minutes`
      : (error as Error).message;
    // Unless it wrote the file and then fell over, in which case the answer is
    // already on disk and the fall is not interesting.
    const written = await readChecks(target);
    return "failed" in written ? { failed: why } : written;
  } finally {
    clearTimeout(timer);
  }

  return readChecks(target);
}

/**
 * Reads back what the agent wrote, keeping only usable entries. Validated here
 * rather than by a schema, which could insist `matches` is a string but not
 * that the string is a pattern JavaScript accepts.
 */
export async function readChecks(target: string): Promise<Derived> {
  const source = await readFile(target, "utf8").catch(() => null);
  if (source === null) return { failed: "the agent wrote no checklist" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { failed: "the checklist it wrote is not JSON" };
  }
  if (!Array.isArray(parsed)) return { failed: "the checklist it wrote is not a list" };

  const found: Check[] = [];
  for (const entry of parsed) {
    const check = usable(entry);
    if (check !== null) found.push(check);
  }
  // An empty list is a real answer — most specs are mostly judgement. What is
  // not a real answer is no list at all, which is the case above.
  return { checks: found, dropped: parsed.length - found.length };
}

const KINDS = new Set(["chain", "http", "dom"]);
const EXPECTATIONS = new Set(["equals", "matches", "contains", "atLeast"]);

/** One proposed entry, or null if it is not a claim anything could settle. */
function usable(entry: unknown): Check | null {
  if (entry === null || typeof entry !== "object") return null;
  const { kind, path, field, expect, because } = entry as Record<string, unknown>;

  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof path !== "string" || path === "") return null;
  if (typeof field !== "string" || field === "") return null;
  if (typeof because !== "string" || because === "") return null;
  if (expect === null || typeof expect !== "object") return null;

  // Exactly one, or it is two claims wearing one locator — and the identity a
  // failure hashes would cover only the first.
  const stated = Object.entries(expect as Record<string, unknown>).filter(
    ([name, value]) => EXPECTATIONS.has(name) && value !== undefined,
  );
  if (stated.length !== 1) return null;

  const [name, value] = stated[0]!;
  if (name === "atLeast" ? typeof value !== "number" : typeof value !== "string" && typeof value !== "number") {
    return null;
  }

  const only = { [name]: value } as Check["expect"];
  return {
    id: locate(kind as Check["kind"], path, field, only),
    kind: kind as Check["kind"],
    path,
    field,
    expect: only,
    because,
  };
}

