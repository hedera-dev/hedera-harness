import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { confirm, terminal } from "./ask.js";
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

const TOOL = "propose_commands";

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
 * drafts the first spec. This is where the agentic work that used to sit in
 * DOCTOR belongs — setup is interactive and happens once, so nothing needs
 * reproducing; a run is the thing that must be deterministic, and it starts
 * from the file this writes.
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
  const proposal = await propose(repoRoot, options.model);

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
 * The grilling: the agent asks one question, the answer comes back, repeat.
 *
 * A single "what are you building?" produces a spec as vague as the sentence
 * that seeded it. What makes a spec checkable is the follow-up — which element,
 * what does it show while loading, what is out of scope — and those are
 * questions only something that has read the project can ask.
 *
 * Built here rather than borrowed: the technique is Matt Pocock's grill-me, but
 * that skill lives in a user's own plugins and the harness cannot require
 * someone to have installed it.
 */
async function draft(repoRoot: string, specPath: string, options: WizardOptions): Promise<boolean> {
  const written = (): boolean => existsSync(join(repoRoot, specPath));

  // Nobody to ask. One pass, and it writes the skeleton it can.
  if (options.assumeYes) {
    await turn(repoRoot, options.model, grillBrief(specPath, false), undefined);
    return written();
  }

  const asker = terminal();
  try {
    let session: string | undefined;
    let next = grillBrief(specPath, true);

    for (let round = 1; round <= GRILL_ROUNDS; round += 1) {
      const said = await turn(repoRoot, options.model, next, session);
      session = said.sessionId;
      if (written()) return true;
      if (said.text === "") break;

      const answer = (await asker.ask(`\n${said.text}\n\n› `)).trim();
      next =
        answer === ""
          ? `That is all. Write ${specPath} now, with an obvious placeholder wherever you had to guess.`
          : answer;
    }
    // Out of rounds: it has enough to write something either way.
    if (!written()) await turn(repoRoot, options.model, `Write ${specPath} now.`, session);
    return written();
  } finally {
    asker.close();
  }
}

const commandShape = z.object({
  run: z.string().min(1).describe("The command exactly as it should be run"),
  cwd: z
    .string()
    .min(1)
    .optional()
    .describe("Directory relative to the repo root. Omit to run at the root."),
});

async function propose(repoRoot: string, model: string): Promise<Proposal> {
  const captured: { proposal: Proposal | null } = { proposal: null };

  const server = createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Report the commands that install, build, test and serve this project.",
        {
          install: commandShape,
          build: commandShape,
          test: commandShape
            .nullable()
            .describe("null if the project genuinely has no test command"),
          serve: commandShape.describe("Starts a long-running dev server"),
          notes: z
            .object({
              install: z.string(),
              build: z.string(),
              test: z.string(),
              serve: z.string(),
            })
            .describe(
              "Why you chose each command — one short sentence each. These are written " +
                "into harness.yaml as comments, so write them for whoever reads that file " +
                "later wondering why this command and not the obvious-looking one.",
            ),
        },
        async (args) => {
          captured.proposal = {
            config: {
              install: args.install as Command,
              build: args.build as Command,
              test: args.test as Command | null,
              serve: args.serve as Command,
            },
            notes: args.notes as Notes,
          };
          return { content: [{ type: "text", text: "Recorded." }] };
        },
      ),
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const conversation = query({
      prompt: commandsBrief(),
      options: {
        cwd: repoRoot,
        model,
        mcpServers: { harness: server },
        // Reading the real files beats being handed excerpts. Nothing is
        // written here — the spec comes later, in its own conversation.
        allowedTools: ["Read", "Glob", "Grep", `mcp__harness__${TOOL}`],
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        maxTurns: MAX_TURNS,
        abortController: controller,
        systemPrompt:
          "You work out how a project installs, builds, tests and serves. " +
          "You report them only by calling the propose_commands tool.",
      },
    });
    for await (const _ of conversation) {
      // Drained; the commands arrive through the tool.
    }
  } catch (error) {
    // Only if nothing arrived. A timeout *after* the tool fired would otherwise
    // throw away a perfectly good proposal.
    if (captured.proposal === null) {
      throw new WizardError(
        `the agent could not be reached (${(error as Error).message}). ` +
          "Run `harness init` to answer the questions yourself.",
      );
    }
  } finally {
    clearTimeout(timer);
  }

  if (captured.proposal === null) {
    throw new WizardError(
      `the agent finished without calling ${TOOL}. ` +
        "Run `harness init` to answer the questions yourself.",
    );
  }
  return captured.proposal;
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

function commandsBrief(): string {
  return [
    "Read this project well enough to say how it installs, builds, tests and serves.",
    "",
    "Script names are frequently misleading: a root package.json may have no",
    "build/test/dev script at all while the real ones are namespaced per workspace,",
    "and a workspace may define `start` as a dev server while `serve` runs the",
    "production build. Read what each script actually does rather than matching on",
    "its name. Then call propose_commands once:",
    "",
    "- prefer a command runnable from the repo root; set cwd only when necessary",
    "- build must produce a production build; serve must start a dev server that",
    "  keeps running and serves the app locally",
    "- test is null only if the project genuinely has no way to run tests",
  ].join("\n");
}

/**
 * The questioner's brief. It asks rather than assumes, because the thing that
 * makes a spec checkable is the detail the user has not thought to give yet.
 */
function grillBrief(specPath: string, interactive: boolean): string {
  const shared = [
    "You are drafting the first spec for this project. Read enough of it to know",
    "its routes, where components and hooks live, and the conventions someone",
    "adding a feature would follow.",
    "",
    `The spec goes to ${specPath}. It is read by a coding agent that implements`,
    "whatever it says, and by a second agent that checks the running app against it",
    "without being allowed to see the code. So:",
    "",
    "- describe what a user sees and how the app behaves, in terms concrete to",
    "  *this* project — name the real directories, routes and conventions you found",
    "- state anything observable in terms a person could check in a browser,",
    "  since that is how it will be judged",
    "- say what is out of scope",
    "",
  ];

  if (!interactive) {
    return [
      ...shared,
      "There is nobody to ask, so write a skeleton: headings and prompts showing",
      "what to describe, with placeholders that are obvious and unmistakably",
      `unfilled. Write it to ${specPath} and nothing else.`,
    ].join("\n");
  }

  return [
    ...shared,
    "First, interview the person. Ask **one question at a time** and wait for the",
    "answer — never a list. Start with what they are building, then follow the",
    "answer: which element shows it, what appears while it is loading, what should",
    "happen when it fails, what is deliberately out of scope. Ask about what they",
    "have not said rather than confirming what they have.",
    "",
    "Your whole reply is the question. No preamble, no summary of what you have",
    "gathered — they can see it.",
    "",
    `When you have enough to write something checkable, stop asking and write`,
    `${specPath}, marking every place you had to guess with an obvious placeholder.`,
    "Write that file and nothing else.",
  ].join("\n");
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
