/**
 * Checks read out of the spec, before the app exists.
 *
 * The conflict of interest this answers is not that a check is agent-authored.
 * It is that the test would be picked in the same moment, and by the same
 * mind, as the verdict — and a judge that has decided an app is fine chooses
 * checks that agree. These exist before anything has been built, so nothing
 * about the app can shape them: the judge receives them as a checklist it must
 * account for, not as claims it chose. What the checklist cannot cover —
 * anything the run creates — the judge verifies on its own, before and after,
 * and cites both readings.
 *
 * It reads the spec and nothing else. No file tools, no repo access, the text
 * inline in the prompt — a pass that could read the code would be forming its
 * checks from the implementation, which is the property being bought.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { confirm } from "./ask.js";
import { type Check, locate } from "./checks.js";
import { emit } from "./events.js";

/** Bounded: reading one document and answering once. */
const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 8;

/** What the agent writes, and the harness reads back. */
const CHECKS_FILE = "checks.json";

export interface DeriveOptions {
  /** The spec's text. Checks are read from it before anything is built. */
  spec: string;
  /** Where the app will run, for the routes a derived check names. */
  appUrlHint: string;
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
 * Shown rather than asked about. Confirming by default would put an
 * interaction on the main path *per spec*, and whether a check says what you
 * meant is usually only visible once it has run. `--review` is there for
 * anyone who disagrees.
 */
export async function deriveChecks(options: DeriveOptions): Promise<Check[]> {
  emit({ type: "phase:started", phase: "derive" });
  const checks = await derive(options.spec, options.appUrlHint, options.model);
  if (checks.length === 0) return [];

  emit({ type: "derived", checks });
  if (options.review) {
    await confirm(
      "Use these?",
      options.assumeYes,
      "declined — edit the spec and run again.",
    );
  }
  return checks;
}

/**
 * Derives what a judge can verify by reading a value, from the spec's own
 * words. Returns nothing rather than throwing: a run without these is the run
 * we had last week, and failing the run because a helper could not be reached
 * would trade a working harness for a stricter one.
 */
export async function derive(spec: string, appUrlHint: string, model: string): Promise<Check[]> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-derive-"));
  const target = join(workspace, CHECKS_FILE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const conversation = query({
      prompt: brief(spec, appUrlHint, target),
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
  } catch {
    // A helper that cannot be reached costs the run nothing it had before.
  } finally {
    clearTimeout(timer);
  }

  return readChecks(target);
}

/**
 * Reads back what the agent wrote, keeping only entries that are actually
 * usable.
 *
 * This validates in code because there is no longer a schema in a tool
 * signature to do it — and a schema never did the work that mattered anyway:
 * it can insist `matches` is a string, not that the string is a pattern
 * JavaScript will accept. The one real malformation we have seen,
 * `(?i)not.?found`, would have passed any schema ever written.
 */
async function readChecks(target: string): Promise<Check[]> {
  const source = await readFile(target, "utf8").catch(() => null);
  if (source === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const found: Check[] = [];
  for (const entry of parsed) {
    const check = usable(entry);
    if (check !== null) found.push(check);
  }
  return found;
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

function brief(spec: string, appUrl: string, target: string): string {
  return [
    "Below is a specification for a web application that does not exist yet.",
    "Read it and state which of its claims a judge could verify by reading a",
    "value — from the mirror node, a route, or an element — with no judgement.",
    "",
    "You have three kinds available:",
    "",
    `- **dom** — what an element shows in a real browser. \`path\` is a route like`,
    "  `/send`, `field` is a CSS selector like `#send-error`. Prefer this for anything",
    "  the spec says a user sees: it waits for the page to render, so it works where",
    "  reading the raw HTML does not.",
    `- **http** — the app will run at ${appUrl}. \`path\` is a route, \`field\` is`,
    "  `status` or `body`. Use it for whether a route exists, not for what it shows.",
    "- **chain** — a read from the Hedera mirror node. `path` is below `/api/v1/`,",
    "  like `accounts/0.0.2`, and `field` is a dotted path such as `balance.balance`.",
    "  Use this only where the spec names a specific account, topic or contract.",
    "",
    "Rules that matter more than coverage:",
    "",
    "- **Only what the spec states plainly.** You are reading someone's words, not",
    "  guessing at an implementation. If a claim needs interpretation, leave it —",
    "  a human judge checks those, and a check that misreads prose fails an app",
    "  that is correct.",
    "- **Nothing that depends on what the run creates.** You cannot name an account",
    "  the app will make, a contract it will deploy, or a transaction it will send;",
    "  none of them exist yet. Those are checked later by someone who watched it happen.",
    "- **A dom check reads text, not state.** It gets what the element shows. A",
    "  spec saying a control is disabled, a field hidden, a row highlighted is",
    "  describing state, and matching the word `disabled` against `Send` fails an",
    "  app that is doing exactly what was asked.",
    "- **Nothing conditional.** \"Once a send completes the id appears\" and \"before",
    "  a send neither element exists\" each describe a moment. A check has no way to",
    "  know which moment it is looking at, so it asserts the condition always held.",
    "  Take only claims true whenever the app is up.",
    "- **Nothing vacuous.** `matches: \".*\"` and `contains: \"\"` hold against a blank",
    "  page. If you cannot say what would make it fail, it is not a check.",
    "- **Patterns are JavaScript.** The judge evaluates them in JavaScript — a",
    "  `node` one-liner or the browser console — which has no inline flags.",
    "  Write `[Nn]ot`, not `(?i)not`.",
    "- **Quote the phrase each check comes from.** A reader has to be able to see",
    "  whether you read it the way they meant it.",
    "- **An empty list is a fine answer.** Most specs are mostly judgement.",
    "",
    "--- the spec ---",
    spec,
    "--- end ---",
    "",
    `Write what you have to ${target}, as a JSON array and nothing else — no`,
    "prose around it, no markdown fence. Each entry:",
    "",
    "    {",
    '      "kind": "chain" | "http" | "dom",',
    '      "path": "accounts/0.0.2" | "/send",',
    '      "field": "balance.balance" | "status" | "body" | "#send-error",',
    '      "expect": { "equals": … } | { "matches": … } | { "contains": … } | { "atLeast": … },',
    '      "because": "the phrase in the spec this comes from, quoted"',
    "    }",
    "",
    "Exactly one key inside `expect`. An empty array `[]` is a fine answer, and",
    "a better one than a check you had to invent.",
  ].join("\n");
}
