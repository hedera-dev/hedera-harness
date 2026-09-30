import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { emit } from "./events.js";
import type { Run } from "./run.js";

/** Where specs live. A convention, not a requirement — `run` takes any path. */
export const SPECS_DIR = "specs";

/** Bounded: reading a repo to draft one document. */
const DRAFT_TIMEOUT_MS = 5 * 60_000;
const MAX_TURNS = 30;

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export interface InitOptions {
  repoRoot: string;
  run: Run;
  model: string;
  /** Becomes `specs/<name>.md`. */
  name: string;
}

export interface InitResult {
  /** Repo-relative path of the spec that was written. */
  path: string;
  /** False when the agent could not be reached and the static skeleton was used. */
  tailored: boolean;
}

/**
 * Writes a spec skeleton for the operator to fill in.
 *
 * Drafted by an agent that has actually read the project, because a generic
 * skeleton cannot name the conventions a spec should follow — where pages
 * live, what the existing routes are, which hooks already exist. Unlike
 * command resolution this call is given file tools: the output is a document
 * a human edits, so there is nothing to keep reproducible.
 */
export async function initialise(options: InitOptions): Promise<InitResult> {
  const relative = join(SPECS_DIR, `${options.name}.md`);
  const target = join(options.repoRoot, relative);

  if (existsSync(target)) {
    throw new InitError(`${relative} already exists. Pick another name, or edit that one.`);
  }

  await mkdir(dirname(target), { recursive: true });

  const tailored = await draft(options, target).catch((error: Error) => {
    emit({
      type: "note",
      level: "warn",
      text: `could not draft a tailored spec (${error.message}) — writing the skeleton`,
    });
    return false;
  });

  if (!tailored) await writeFile(target, SKELETON);
  emit({ type: "spec:written", path: relative, tailored });
  return { path: relative, tailored };
}

/**
 * Lets the agent write the file itself. There was an MCP tool here that took
 * the markdown as an argument and put it in a variable — a schema that enforced
 * nothing, wrapping a capability the agent already ships.
 */
async function draft(options: InitOptions, target: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS);

  try {
    const conversation = query({
      prompt: brief(options.name, target),
      options: {
        cwd: options.repoRoot,
        model: options.model,
        // One file, named in the prompt. Everything else is read-only: this is
        // here to understand the project, not to change it.
        allowedTools: ["Read", "Glob", "Grep", "Write"],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        maxTurns: MAX_TURNS,
        abortController: controller,
      },
    });
    for await (const _ of conversation) {
      // Drained; the draft arrives on disk.
    }
  } finally {
    clearTimeout(timer);
  }

  // The file is the answer, so nothing needs parsing — but an agent that talked
  // about writing it without writing it must still fall back to the skeleton.
  return existsSync(target);
}

function brief(name: string, target: string): string {
  return [
    "Read enough of this project to understand what it is and how it is organised:",
    "its routes or pages, where components, hooks and utilities live, and the",
    "conventions someone adding a feature would be expected to follow.",
    "",
    `Then write a spec *skeleton* for a feature called "${name}" — a document the`,
    "developer will fill in, not a finished specification. It is read by a coding",
    "agent that will implement whatever it says, and by a second agent that will",
    "check the running app against it without being allowed to see the code.",
    "",
    "Write it so that:",
    "",
    "- headings and prompts show what to describe: what a user sees, how it behaves,",
    "  what is out of scope",
    "- placeholders are obvious and unmistakably unfilled",
    "- guidance is concrete to *this* project — name the real directories, the",
    "  existing routes, the conventions you actually found, so the developer knows",
    "  where a feature would go",
    "- it reminds the writer that anything observable should be stated in terms a",
    "  person could check in a browser, since that is how it will be judged",
    "",
    "Do not invent a feature and do not write requirements. The developer supplies",
    "the intent; you supply the shape and the local detail.",
    "",
    `Write the finished markdown to ${target} and nothing else. Do not create or`,
    "modify any other file.",
  ].join("\n");
}

/** Used when the agent cannot be reached. Deliberately plain. */
const SKELETON = `# Feature name

One sentence saying what this adds and who it is for.

## What a user sees

Describe the visible result. Name routes, elements and values concretely — this
is judged by an agent driving a browser, so anything you cannot point at will
not be checked.

- [ ] ...

## Behaviour

What happens when it is used, including while loading and when something fails.

- [ ] ...

## Constraints

Anything that must or must not happen: no new dependencies, follow existing
patterns, read-only, no credentials required.

- [ ] ...

## Out of scope

What this feature deliberately does not do.
`;
