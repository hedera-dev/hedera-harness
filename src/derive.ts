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
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Check, locate } from "./checks.js";

/** Bounded: reading one document and answering once. */
const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 8;

const TOOL = "propose_checks";

/**
 * Derives what a judge can verify by reading a value, from the spec's own
 * words. Returns nothing rather than throwing: a run without these is the run
 * we had last week, and failing DOCTOR because a helper could not be reached
 * would trade a working harness for a stricter one.
 */
export async function derive(spec: string, appUrlHint: string, model: string): Promise<Check[]> {
  const found: Check[] = [];

  const server = createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Submit the claims in this spec that a judge can verify by reading a value. Call once.",
        {
          checks: z
            .array(
              z.object({
                kind: z.enum(["chain", "http", "dom"]),
                path: z
                  .string()
                  .min(1)
                  .describe(
                    "For chain: a mirror node path below /api/v1/, e.g. `accounts/0.0.2`. " +
                      "For http and dom: a route on the app, e.g. `/send`.",
                  ),
                field: z
                  .string()
                  .describe(
                    "For chain: a dotted path into the response, e.g. `balance.balance`. " +
                      "For http: `status` or `body`. For dom: a CSS selector, e.g. `#send-error`.",
                  ),
                expect: z.object({
                  equals: z.union([z.string(), z.number()]).optional(),
                  matches: z.string().optional(),
                  contains: z.string().optional(),
                  atLeast: z.number().optional(),
                }),
                /** Kept so a failing check can show the words it came from. */
                because: z
                  .string()
                  .min(1)
                  .describe("The phrase in the spec this comes from, quoted, so a reader can judge it"),
              }),
            )
            .describe("Only what the spec states plainly. An empty list is a fine answer."),
        },
        async (args) => {
          for (const proposed of args.checks) {
            const expect = Object.fromEntries(
              Object.entries(proposed.expect).filter(([, value]) => value !== undefined),
            );
            if (Object.keys(expect).length !== 1) continue;
            found.push({
              id: locate(proposed.kind, proposed.path, proposed.field, expect as Check["expect"]),
              kind: proposed.kind,
              path: proposed.path,
              field: proposed.field,
              expect: expect as Check["expect"],
              because: proposed.because,
            });
          }
          return { content: [{ type: "text", text: `Recorded ${found.length}.` }] };
        },
      ),
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const conversation = query({
      prompt: brief(spec, appUrlHint),
      options: {
        model,
        mcpServers: { harness: server },
        // The spec is in the prompt and there is nothing else to read. A pass
        // that could open the repo would be deriving from the implementation.
        allowedTools: [`mcp__harness__${TOOL}`],
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: MAX_TURNS,
        abortController: controller,
        systemPrompt:
          "You turn a written specification into claims a judge can verify by " +
          "reading a value. You answer only by calling the propose_checks tool.",
      },
    });
    for await (const _ of conversation) {
      // Drained for the tool call; the checks arrive through the handler.
    }
  } catch {
    // A helper that cannot be reached costs the run nothing it had before.
  } finally {
    clearTimeout(timer);
  }
  return found;
}

function brief(spec: string, appUrl: string): string {
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
    `Call ${TOOL} once with what you have.`,
  ].join("\n");
}
