import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { confirm, interview, terminal, working } from "./ask.js";
import { COMMANDS_FILE, commandsBrief, grillBrief } from "./prompts/wizard.js";
import type { Command } from "./commands.js";
import {
  CONFIG_FILE,
  type HarnessConfig,
  commandProblem,
  entries,
  readConfig,
  writeConfig,
} from "./config.js";
import { emit } from "./events.js";
import { commit } from "./git.js";

/** Where specs live. A convention, not a requirement — `run` takes any path. */
export const SPECS_DIR = "specs";

/** Bounded: reading a repo, proposing four commands, drafting one document. */
const TIMEOUT_MS = 5 * 60_000;
const MAX_TURNS = 30;

/** Questions before it must write what it has. Enough to get specific, not an interview. */
const GRILL_ROUNDS = 8;

export class WizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WizardError";
  }
}

export interface WizardOptions {
  repoRoot: string;
  /** Becomes `specs/<name>.md`. */
  name: string;
  model: string;
  /** Take the agent's proposal without confirming it. */
  assumeYes: boolean;
}

/** One sentence per command, written into `harness.yaml` above the line it explains. */
interface Notes {
  install: string;
  build: string;
  test: string;
  serve: string;
}

interface Proposal {
  config: HarnessConfig;
  notes: Notes;
}

/**
 * The agentic setup: an agent reads the project, proposes its commands, and
 * drafts the first spec. Setup is interactive and happens once, so nothing here
 * needs reproducing; the run that reads these files is what must be
 * deterministic.
 *
 * The commands arrive through a tool because the harness consumes them
 * mechanically; the spec arrives as a file because a human edits it.
 */
export async function wizard(options: WizardOptions): Promise<void> {
  const { repoRoot } = options;
  if ((await readConfig(repoRoot)) !== null) {
    throw new WizardError(`${CONFIG_FILE} already exists — edit it directly.`);
  }
  const specPath = join(SPECS_DIR, `${options.name}.md`);
  if (existsSync(join(repoRoot, specPath))) {
    throw new WizardError(`${specPath} already exists. Pick another name, or edit that one.`);
  }

  // Commands first, and committed before a word is said about the feature.
  // Someone who abandons the questions still walks away with a working config,
  // which is the half a run cannot start without.
  const stop = working("reading the project to work out its commands");
  const proposal = await propose(repoRoot, options.model).finally(stop);

  // The agentic path is the one whose commands nobody typed, so it is the one
  // that most needs checking. `init` has always done this; the wizard did not.
  for (const [name, command] of entries(proposal.config)) {
    if (command === null) continue;
    const problem = await commandProblem(command, repoRoot);
    if (problem !== null) emit({ type: "note", level: "warn", text: `${name} ${problem}` });
  }

  emit({
    type: "proposal",
    commands: [
      { name: "install", command: proposal.config.install, note: proposal.notes.install },
      { name: "build", command: proposal.config.build, note: proposal.notes.build },
      { name: "test", command: proposal.config.test, note: proposal.notes.test },
      { name: "serve", command: proposal.config.serve, note: proposal.notes.serve },
    ],
  });
  await confirm(
    "Use these?",
    options.assumeYes,
    `declined. Write ${CONFIG_FILE} by hand, or run \`harness init\`.`,
  );

  await writeConfig(repoRoot, proposal.config, proposal.notes);
  // Same reason init commits: an uncommitted config is dirt under DOCTOR.
  await commit([CONFIG_FILE], `chore: record harness commands in ${CONFIG_FILE}`, repoRoot);

  const tailored = await draft(repoRoot, specPath, options);
  if (!tailored) {
    await mkdir(dirname(join(repoRoot, specPath)), { recursive: true });
    await writeFile(join(repoRoot, specPath), SKELETON);
  }
  emit({ type: "spec:written", path: specPath, tailored });
}

/**
 * The grilling: one question, the answer, repeat.
 *
 * What makes a spec checkable is the follow-up — which element, what it shows
 * while loading, what is out of scope — so a single opening question would
 * produce a spec as vague as the sentence that seeded it.
 *
 * The technique is Matt Pocock's grill-me, built here rather than loaded: that
 * skill lives in a user's own plugins, which the harness cannot require.
 */
async function draft(repoRoot: string, specPath: string, options: WizardOptions): Promise<boolean> {
  const written = (): boolean => existsSync(join(repoRoot, specPath));

  // Nobody to ask. One pass, and it writes the skeleton it can.
  if (options.assumeYes) {
    const stop = working("drafting the spec skeleton");
    await turn(repoRoot, options.model, grillBrief(specPath, false), undefined).finally(stop);
    return written();
  }

  const asker = terminal();
  try {
    let session: string | undefined;
    let next = grillBrief(specPath, true);

    for (let round = 1; round <= GRILL_ROUNDS; round += 1) {
      const thinking = working(round === 1 ? "preparing the interview" : "thinking");
      const said = await turn(repoRoot, options.model, next, session).finally(thinking);
      session = said.sessionId;
      if (written()) return true;
      if (said.text === "") break;

      const answer = await interview(asker, said.text, round, GRILL_ROUNDS);
      next =
        answer === ""
          ? `That is all. Write ${specPath} now, with an obvious placeholder wherever you had to guess.`
          : answer;
    }
    // Out of rounds: it has enough to write something either way.
    if (!written()) {
      const stop = working(`writing ${specPath}`);
      await turn(repoRoot, options.model, `Write ${specPath} now.`, session).finally(stop);
    }
    return written();
  } finally {
    asker.close();
  }
}

async function propose(repoRoot: string, model: string): Promise<Proposal> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-wizard-"));
  const target = join(workspace, COMMANDS_FILE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const conversation = query({
      prompt: commandsBrief(target),
      options: {
        cwd: repoRoot,
        model,
        // Reading the real files beats being handed excerpts. The only thing it
        // writes is the answer, outside the repo.
        allowedTools: ["Read", "Glob", "Grep", "Write"],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        maxTurns: MAX_TURNS,
        abortController: controller,
        systemPrompt:
          "You work out how a project installs, builds, tests and serves, and " +
          "write the answer as one JSON file.",
      },
    });
    for await (const _ of conversation) {
      // Drained; the commands arrive on disk.
    }
  } finally {
    clearTimeout(timer);
  }

  const proposal = await readProposal(target);
  if (proposal === null) {
    throw new WizardError(
      "the agent did not produce a usable set of commands. " +
        "Run `harness init` to answer the questions yourself.",
    );
  }
  return proposal;
}

/**
 * Reads back what the agent wrote. Validated here because there is no schema in
 * a tool signature doing it any more — though a schema never gave the guarantee
 * that matters: it can insist `run` is a string, not that the script exists.
 * That is `commandProblem`'s job, and it runs on what this returns.
 */
async function readProposal(target: string): Promise<Proposal | null> {
  const source = await readFile(target, "utf8").catch(() => null);
  if (source === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const { install, build, test, serve, notes } = parsed as Record<string, unknown>;
  const required = { install: command(install), build: command(build), serve: command(serve) };
  if (Object.values(required).some((value) => value === null)) return null;

  // `test` alone may be absent: a project with no tests is a fact, not a flaw.
  const tested = test === null || test === undefined ? null : command(test);

  return {
    config: {
      install: required.install!,
      build: required.build!,
      test: tested,
      serve: required.serve!,
    },
    notes: written(notes),
  };
}

/** `{ run, cwd? }`, or null when it is not one. */
function command(value: unknown): Command | null {
  if (value === null || typeof value !== "object") return null;
  const { run, cwd } = value as Record<string, unknown>;
  if (typeof run !== "string" || run.trim() === "") return null;
  return typeof cwd === "string" && cwd !== "" ? { run, cwd } : { run };
}

/** Missing reasoning costs a comment in the file, never the command itself. */
function written(value: unknown): Notes {
  const given = (value ?? {}) as Record<string, unknown>;
  const one = (name: string): string => (typeof given[name] === "string" ? (given[name] as string) : "");
  return { install: one("install"), build: one("build"), test: one("test"), serve: one("serve") };
}

/** One exchange of the grilling. Returns what it said, and where to resume. */
async function turn(
  repoRoot: string,
  model: string,
  prompt: string,
  resume: string | undefined,
): Promise<{ text: string; sessionId: string | undefined }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let text = "";
  let sessionId: string | undefined;
  try {
    const conversation = query({
      prompt,
      options: {
        cwd: repoRoot,
        model,
        ...(resume === undefined ? {} : { resume }),
        allowedTools: ["Read", "Glob", "Grep", "Write"],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        maxTurns: MAX_TURNS,
        abortController: controller,
      },
    });
    for await (const message of conversation) {
      sessionId ??= message.session_id;
      if (message.type !== "assistant") continue;
      text = message.message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();
    }
  } catch {
    // A conversation that cannot continue ends the grilling; the skeleton is
    // still written, and the config — the half a run needs — is already safe.
  } finally {
    clearTimeout(timer);
  }
  return { text, sessionId };
}

/** Used when the agent proposed commands but never wrote the spec. Deliberately plain. */
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
