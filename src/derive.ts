/**
 * Checks read out of the spec, before the app exists.
 *
 * The conflict of interest this answers is not that a check is agent-authored.
 * It is that **the same mind picks the test and renders the verdict, in the
 * same moment** — and a judge that decides an app is fine will choose checks
 * that agree. Every check the harness settles today comes from that judge, so
 * "no check has ever caught a bad pass" is unfalsifiable rather than
 * reassuring: you cannot detect a lenient judge with an instrument it controls.
 *
 * These exist before anything has been built, so nothing about the app can
 * shape them. They are pinned for the run and reused across attempts, and the
 * evaluator never sees them — it declares its own, which cover what this
 * cannot: anything the run creates. The two sources are disjoint on purpose.
 *
 * It reads the spec and nothing else. No file tools, no repo access, the text
 * inline in the prompt — a pass that could read the code would be forming its
 * checks from the implementation, which is the property being bought.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Check, locate } from "./checks.js";

/** See PLAN-V2 § Bounds. Reading one document and answering once. */
const TIMEOUT_MS = 3 * 60_000;
const MAX_TURNS = 8;

const TOOL = "propose_checks";

/**
 * Derives what can be settled mechanically from the spec's own words. Returns
 * nothing rather than throwing: a run without these is the run we had last
 * week, and failing DOCTOR because a helper could not be reached would trade a
 * working harness for a stricter one.
 */
export async function derive(spec: string, appUrlHint: string, model: string): Promise<Check[]> {
  const found: Check[] = [];

  const server = createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        TOOL,
        "Submit the claims in this spec that a machine can settle. Call once.",
        {
          checks: z
            .array(
              z.object({
                kind: z.enum(["chain", "http"]),
                path: z
                  .string()
                  .min(1)
                  .describe(
                    "For chain: a mirror node path below /api/v1/, e.g. `accounts/0.0.2`. " +
                      "For http: a route on the app, e.g. `/send`.",
                  ),
                field: z
                  .string()
                  .describe(
                    "For chain: a dotted path into the response, e.g. `balance.balance`. " +
                      "For http: `status` or `body`.",
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
              source: "derived",
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
          "You turn a written specification into claims a machine can settle. " +
          "You answer only by calling the propose_checks tool.",
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
    "Read it and state which of its claims a machine could settle on its own,",
    "with no judgement and no browser.",
    "",
    "You have two kinds available:",
    "",
    `- **http** — the app will run at ${appUrl}. \`path\` is a route like \`/send\`,`,
    "  `field` is `status` or `body`. Use this for routes the spec says exist.",
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
    "- **Nothing conditional.** \"Once a send completes the id appears\" and \"before",
    "  a send neither element exists\" each describe a moment. A check has no way to",
    "  know which moment it is looking at, so it asserts the condition always held.",
    "  Take only claims true whenever the app is up.",
    "- **Nothing vacuous.** `matches: \".*\"` and `contains: \"\"` hold against a blank",
    "  page. If you cannot say what would make it fail, it is not a check.",
    "- **Patterns are JavaScript.** They go to `new RegExp`, which has no inline",
    "  flags — write `[Nn]ot`, not `(?i)not`. One that will not parse is discarded.",
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
