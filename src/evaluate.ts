import { appendFile, cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type Check, type CheckResult, baseline, locate, settleAll } from "./checks.js";
import { emit } from "./events.js";
import { type Wallet, mirrorNode, network, redact, wallet } from "./wallet.js";
import { describeMessage, endingOf, said } from "./messages.js";
import type { Run } from "./run.js";

/** See PLAN-V2 § Bounds — shorter than GENERATE: judging is cheaper than building. */
const WALL_CLOCK_MS = 20 * 60_000;
/**
 * A turn is one round-trip to the model, and real evaluations cost about
 * $0.012 of them — so this bound is also a spend bound, whether or not it is
 * named like one. At 120 it bites around $1.68, well clear of MAX_BUDGET_USD
 * and roughly twice the busiest evaluation yet measured (57 turns).
 *
 * It was briefly 300, which works out at ~$4.20 — within 15% of the budget cap,
 * so the two would have fired at almost the same moment and one of them would
 * have stopped being a bound at all. Move this only when it has actually
 * stopped legitimate work, not because it is the tightest number here; something
 * always is. Breaching it now costs a pause rather than the run.
 */
const MAX_TURNS = 120;
const MAX_BUDGET_USD = 5;

const TOOL = "submit_verdict";
const DECLARE = "declare_check";
const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export class EvaluateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluateError";
  }
}

export interface Failure {
  what: string;
  where: string;
  evidence: string[];
}

export interface Verdict {
  pass: boolean;
  failures: Failure[];
}

/**
 * Either the evaluator answered, or it did not. There is no third state: a
 * well-formed verdict is final and is never re-rolled, while "no verdict"
 * means exactly the three cases below and earns one retry.
 */
export type Outcome =
  | { type: "verdict"; verdict: Verdict; checks: CheckResult[] }
  | { type: "no-verdict"; reason: string; why: Unanswered };

/**
 * The three ways an evaluation ends without an answer, which need different
 * things said to them. Matching on the reason's prose would work until someone
 * reworded it.
 */
export type Unanswered =
  /** A bound stopped it: it had not decided it was finished. */
  | "cut-off"
  /** It ended its own turn without calling the tool. */
  | "unreported"
  /** It answered, but cited evidence that is not on disk. */
  | "unevidenced";

export interface EvaluateOptions {
  repoRoot: string;
  /** Read from the spec at DOCTOR, before the app existed. Settled alongside the judge's own. */
  checks: Check[];
  run: Run;
  specPath: string;
  attempt: number;
  model: string;
  appUrl: string;
}

const failureShape = z.object({
  what: z.string().min(1).describe("What a user cannot do, in their terms"),
  /**
   * Kept to a bare locator on purpose. The harness hashes this to tell a
   * repeated failure from a new one across attempts, and a fresh evaluator
   * each attempt words prose differently every time — two runs describing
   * one bug would look like two bugs.
   */
  where: z
    .string()
    .min(1)
    .describe(
      "Where it happens, as a bare locator and nothing else: a route like " +
        "`/?n=5`, or a selector like `#result`. No sentences, no explanation.",
    ),
  /**
   * A list rather than a string, because a single field invites prose: the
   * first evaluator to fail a spec answered with a filename followed by a
   * parenthesised explanation, and the whole thing was read as a path.
   * Explanation belongs in `what`; this field holds only references.
   */
  evidence: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "One entry per piece of evidence, each either a filename you saved in " +
        "evidence/ or a mirror node URL. Nothing else — no sentences, no notes " +
        "in brackets. Put the explanation in `what`.",
    ),
});

/**
 * Judges the running app against the spec, from a directory that holds only
 * the spec. The evaluator never sees the code, the diff, or this harness —
 * enforcement is the sandbox plus a read deny on the repo, not the prompt.
 *
 * A fresh evaluator every attempt, deliberately: one that remembered its own
 * previous findings would re-check those and wave the rest through, arriving
 * already expecting a broken app.
 */
export async function evaluate(options: EvaluateOptions): Promise<Outcome> {
  const { run, attempt, appUrl } = options;

  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-"));
  await mkdir(join(workspace, "evidence"));
  await cp(options.specPath, join(workspace, "spec.md"));

  const captured: Captured = { verdict: null, malformed: null, checks: [] };
  const chain = hedera();
  const server = verdictServer(captured, chain.mirrorNode);
  const transcript = await run.path(`attempt-${attempt}`, "evaluate.jsonl");

  emit({
    type: "phase:started",
    phase: "evaluate",
    attempt,
    detail: `${options.model} · blind · ${appUrl}`,
  });

  let { outcome, sessionId } = await pass(options, workspace, server, transcript, {
    prompt: brief(appUrl, hedera()),
    captured,
  });

  if (outcome.type === "no-verdict") {
    // Resumed, not restarted: a fresh evaluator re-opens the browser, re-reads
    // the chain and re-runs every wait, which on the one real occurrence
    // repeated 28 tool calls. It does not weaken "a verdict is never
    // re-rolled" — that rule stops an evaluator diffing against its own
    // previous verdict, and here there is none.
    emit({
      type: "note",
      level: "warn",
      text: `no verdict (${outcome.reason}) — asking the same evaluator to finish`,
      attempt,
    });
    // The one retry that starts from an existing verdict. The app has not
    // changed between passes — same commit, same server — so the only correct
    // response to a broken citation is to save the file or name one that
    // exists. A retry that drops a finding instead has re-rolled a verdict,
    // which is the one thing this stage may never do.
    const judged = outcome.why === "unevidenced" ? locators(captured.verdict) : null;

    captured.malformed = null;
    ({ outcome } = await pass(options, workspace, server, transcript, {
      prompt: nudge(outcome),
      captured,
      resume: sessionId,
    }));

    if (judged !== null && outcome.type === "verdict") {
      const now = locators(outcome.verdict);
      if (now !== judged) {
        outcome = {
          type: "no-verdict",
          reason:
            `the retry changed its findings rather than its citations ` +
            `(${judged || "none"} became ${now || "none"}). It was asked to fix ` +
            `how a finding is evidenced, not whether it stands.`,
          why: "unevidenced",
        };
      }
    }
    if (outcome.type === "no-verdict") {
      outcome = { type: "no-verdict", reason: `${outcome.reason} (asked twice)`, why: outcome.why };
    }
  }

  // Every declared claim is settled before the verdict is accepted, and a
  // failing one turns a pass into a fail. Mechanical rejection beats an LLM
  // approval, never the reverse: a judge that passed over its own failed check
  // has contradicted itself, which is the strongest reason there is to reject.
  // An unreadable check is a warning — the mechanical layer must never
  // manufacture failures out of its own bugs.
  const settled = await settleAll(
    { mirrorNode: chain.mirrorNode, appUrl },
    [...options.checks, ...captured.checks],
    attempt,
  );
  await writeFile(
    await run.path(`attempt-${attempt}`, "checks.json"),
    `${JSON.stringify(settled, null, 2)}\n`,
  );
  // What the judge said, recorded before the harness has its say. Overwriting it
  // with the overridden result would make the one thing this feature exists to
  // expose — the harness disagreeing with the judge — invisible afterwards.
  if (outcome.type === "verdict") {
    await writeFile(
      await run.path(`attempt-${attempt}`, "verdict.json"),
      `${JSON.stringify({ ...outcome.verdict, judgedBy: options.model }, null, 2)}\n`,
    );
  }
  outcome = override(outcome, settled);

  // Evidence is collected whatever the outcome — a run that produced no verdict
  // is exactly when you want to see what the evaluator was looking at.
  await cp(join(workspace, "evidence"), await run.path(`attempt-${attempt}`, "evidence"), {
    recursive: true,
  });

  return outcome;
}

/**
 * Mechanical rejection beats an LLM approval, never the reverse.
 *
 * A judge that passed over a claim it declared and the harness found untrue has
 * contradicted itself, which is the strongest reason there is to reject. The
 * asymmetry matters as much as the rule: a check that held never rescues a
 * failed verdict, because the judge saw things no check was written for.
 *
 * `errored` is not `failed`. A path that 404s or a field that is absent is the
 * check being wrong, not the app — and a mechanical layer that manufactures
 * failures out of its own bugs stops being the thing worth trusting.
 */
export function override(outcome: Outcome, settled: CheckResult[]): Outcome {
  if (outcome.type !== "verdict") return outcome;
  // Only a claim the judge made itself. A derived check that fails is one
  // reading of a spec disagreeing with an app, and nothing present can say
  // which of the two is wrong — across four real specs, roughly one derived
  // check in ten would have failed a working app. Those are reported instead,
  // which costs the point of them nothing: a derived check failing while the
  // judge passed is still the leniency showing, whether or not it fails the run.
  const untrue = settled.some(
    (result) => result.state === "failed" && result.check.source === "declared",
  );
  return {
    type: "verdict",
    verdict: { ...outcome.verdict, pass: outcome.verdict.pass && !untrue },
    checks: settled,
  };
}

interface Captured {
  verdict: Verdict | null;
  malformed: string | null;
  /** Claims the evaluator asked the harness to settle, in declaration order. */
  checks: Check[];
}

/**
 * One turn of the evaluator, bounded on its own. Returns what the harness makes
 * of it — a verdict, or one of the three ways there is not one.
 */
async function pass(
  options: EvaluateOptions,
  workspace: string,
  server: ReturnType<typeof createSdkMcpServer>,
  transcript: string,
  turn: { prompt: string; captured: Captured; resume?: string | undefined },
): Promise<{ outcome: Outcome; sessionId: string | undefined }> {
  const { repoRoot, attempt } = options;
  const signer = wallet();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WALL_CLOCK_MS);
  const startedAt = Date.now();
  let costUsd: number | undefined;
  let sessionId: string | undefined;

  // The agent's Bash resolves `playwright-cli` from the harness's own install,
  // so the target repo does not have to depend on it.
  const previousPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${join(HARNESS_ROOT, "node_modules", ".bin")}:${previousPath}`;

  // The brief carries the wallet key, so this is the one recording that must
  // never be written verbatim.
  await said(transcript, turn.resume === undefined ? "prompt" : "nudge", turn.prompt, signer?.key);

  try {
    const conversation = query({
      prompt: turn.prompt,
      options: {
        cwd: workspace,
        model: options.model,
        ...(turn.resume === undefined ? {} : { resume: turn.resume }),
        plugins: [{ type: "local", path: playwrightSkills() }],
        mcpServers: { harness: server },
        settingSources: [],
        permissionMode: "bypassPermissions",
        sandbox: {
          enabled: true,
          // A missing seatbelt or bubblewrap must abort, never silently
          // downgrade to an unsandboxed evaluator.
          failIfUnavailable: true,
          filesystem: { denyRead: [repoRoot, HARNESS_ROOT] },
        },
        maxTurns: MAX_TURNS,
        maxBudgetUsd: MAX_BUDGET_USD,
        abortController: controller,
      },
    });

    for await (const message of conversation) {
      // The key is in this agent's context, so it is in anything it echoes. The
      // transcript records every message either way, which makes it the one
      // artifact a live key must never survive in — so the scrub happens at the
      // write, not at the agent's discretion.
      await appendFile(transcript, `${redact(JSON.stringify(message), signer?.key)}\n`);
      const step = describeMessage(message);
      if (step !== null) {
        emit({ type: "tool", tool: step.tool, argument: step.argument, phase: "evaluate", attempt });
      }
      sessionId ??= message.session_id;
      // A bound the SDK enforces itself arrives as an error result and *then*
      // throws when the iterator is pulled again. Reading it here is what turns
      // "the run died" into "no verdict, ask once more", which is what the
      // bounds table always said it was.
      const ending = endingOf(message, MAX_TURNS);
      if (ending !== null) {
        costUsd = ending.costUsd;
        if (ending.failure !== null) {
          const stopped = `the evaluator stopped because ${ending.failure.reason}`;
          // A bound another turn could satisfy earns the retry the bounds table
          // always promised. Anything else ends the run rather than quietly
          // buying a second allowance of whatever was just exhausted.
          if (!ending.failure.recoverable) throw new EvaluateError(stopped);
          turn.captured.malformed = stopped;
        }
      }
    }
  } catch (error) {
    if (error instanceof EvaluateError) throw error;
    if (controller.signal.aborted) {
      turn.captured.malformed = `the evaluator did not finish within ${WALL_CLOCK_MS / 60_000} minutes`;
    } else if (turn.captured.malformed === null) {
      throw error;
    }
    // Otherwise the stream already said why it stopped, and the throw is the
    // same news arriving twice.
  } finally {
    clearTimeout(timer);
    process.env["PATH"] = previousPath;
  }

  const outcome = adjudicate(turn.captured, workspace);
  emit({
    type: "evaluate:finished",
    attempt,
    verdict: outcome.type === "no-verdict" ? "none" : outcome.verdict.pass ? "pass" : "fail",
    findings: outcome.type === "no-verdict" ? 0 : outcome.verdict.failures.length,
    costUsd,
    durationMs: Date.now() - startedAt,
  });
  return { outcome, sessionId };
}

function verdictServer(
  captured: Captured,
  mirrorNode: string,
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: "harness",
    tools: [
      tool(
        DECLARE,
        "State a claim about chain state that the harness will check itself. Declare it " +
          "BEFORE the action that should make it true — a change can only be measured " +
          "against a value recorded beforehand.",
        {
          path: z
            .string()
            .min(1)
            .describe("Mirror node path below /api/v1/, e.g. `accounts/0.0.2`"),
          field: z
            .string()
            .min(1)
            .describe("Dotted path into the response, e.g. `balance.balance`. Units are the mirror node's."),
          expect: z
            .object({
              equals: z.union([z.string(), z.number()]).optional(),
              matches: z.string().optional(),
              contains: z.string().optional(),
              atLeast: z.number().optional(),
              changedBy: z.number().optional(),
              increasedBy: z.number().optional(),
            })
            .describe("Exactly one of these."),
        },
        async (args) => {
          const expect = Object.fromEntries(
            Object.entries(args.expect).filter(([, value]) => value !== undefined),
          );
          if (Object.keys(expect).length !== 1) {
            return { content: [{ type: "text", text: "Give exactly one expectation." }] };
          }
          const check = await baseline(mirrorNode, {
            id: locate("chain", args.path, args.field, expect as Check["expect"]),
            source: "declared",
            kind: "chain",
            path: args.path,
            field: args.field,
            expect: expect as Check["expect"],
          });
          captured.checks.push(check);
          return {
            content: [
              { type: "text", text: `Recorded. The harness will settle ${check.id} itself.` },
            ],
          };
        },
      ),
      tool(
        TOOL,
        "Report whether the running app satisfies the spec. Call this exactly once, at the end.",
        {
          pass: z.boolean().describe("true only if every requirement in the spec is met"),
          failures: z
            .array(failureShape)
            .describe("Empty when passing. One entry per requirement that is not met."),
        },
        async (args) => {
          const failures = (args.failures as Failure[]).map((failure) => ({
            ...failure,
            evidence: failure.evidence.map(cited),
          }));
          captured.verdict = { pass: args.pass, failures };
          // Answering ends the turn. Without this the evaluator decides for
          // itself when it is finished, and the one time it got that wrong it
          // ended without answering at all.
          return {
            content: [{ type: "text", text: "Verdict recorded." }],
            _meta: { "claude/endTurn": true },
          };
        },
      ),
    ],
  });
}

/**
 * What the harness says when it intervenes.
 *
 * An evaluator that was cut off mid-check needs the opposite advice from one
 * that finished and forgot to answer. Telling the first that it already has
 * what it needs would buy a fast verdict at the cost of a thorough one, which
 * is the only thing this stage is for.
 */
/** What a verdict found, ignoring how it evidenced it. Order-insensitive. */
export function locators(verdict: Verdict | null): string {
  if (verdict === null) return "";
  return verdict.failures.map((failure) => failure.where).sort().join(", ");
}

/** Exported for tests: the three-way branch decides how thorough the retry is. */
export function nudge(outcome: { reason: string; why: Unanswered }): string {
  const opening = [
    `Your turn ended without a usable verdict: ${outcome.reason}`,
    "",
    "Nothing resumed you automatically — this message is the harness intervening,",
    "and it is the last turn you get. Do not start anything in the background and",
    "do not wait to be notified: wait in the foreground, with commands that block.",
    "",
  ];
  const closing = {
    "cut-off": [
      "You were stopped before you were done, not because you were wrong. Finish",
      "the checks you had not reached — the spec is still in spec.md and your",
      `evidence is still in evidence/ — and only then call ${TOOL}.`,
      "Do not pass a requirement you have not actually checked.",
    ],
    unreported: [
      `You did the work and ended without reporting it. Call ${TOOL} now with what`,
      "you found. Check anything you are unsure of first.",
    ],
    unevidenced: [
      "Your verdict cited evidence the harness cannot find. Save the files you",
      "meant to cite into evidence/, or cite only files that are there, and call",
      `${TOOL} again. A finding nobody can check is not a finding.`,
      "",
      "Report the same findings. You are fixing how they are evidenced, not",
      "whether they stand — the app has not changed since you looked at it.",
    ],
  }[outcome.why];
  return [...opening, ...closing].join("\n");
}

/**
 * The three ways there is no verdict: the evaluator never called the tool,
 * the payload was not usable, or it cited evidence that is not on disk.
 * Anything else the evaluator says is an answer, and answers stand.
 */
function adjudicate(
  captured: { verdict: Verdict | null; malformed: string | null },
  workspace: string,
): Outcome {
  if (captured.malformed !== null) {
    return { type: "no-verdict", reason: captured.malformed, why: "cut-off" };
  }
  if (captured.verdict === null) {
    return {
      type: "no-verdict",
      reason: `the evaluator finished without calling ${TOOL}`,
      why: "unreported",
    };
  }

  const missing = captured.verdict.failures
    .flatMap((failure) => failure.evidence)
    .filter((evidence) => !resolves(evidence, workspace));

  if (missing.length > 0) {
    return {
      type: "no-verdict",
      reason:
        `the verdict cites evidence that is not there: ${missing.join(", ")}. ` +
        `A finding the harness cannot see is not a finding.`,
      why: "unevidenced",
    };
  }
  return { type: "verdict", verdict: captured.verdict, checks: [] };
}

/**
 * A citation reduced to the name it has inside `evidence/`.
 *
 * The evaluator writes `shot.png`, `evidence/shot.png` and absolute paths into
 * its own workspace, all meaning the same file. Accepting every form and then
 * building a path from the raw string produced `evidence/evidence/shot.png` in
 * the repair prompt — an unopenable path, in the one message whose job is to
 * hand the agent something it can open. Normalising once, here, means the check
 * and the path it later becomes cannot disagree.
 */
export function cited(evidence: string): string {
  if (/^https?:\/\//.test(evidence)) return evidence;
  return evidence.replace(/^(?:.*\/)?evidence\//, "").replace(/^\.\//, "");
}

/**
 * Evidence is a file under `evidence/`, or a URL. Nothing else: only that
 * directory is copied into the run, so a file cited from anywhere else passes
 * the check and then points nowhere.
 */
function resolves(evidence: string, workspace: string): boolean {
  if (/^https?:\/\//.test(evidence)) return true;
  return existsSync(join(workspace, "evidence", evidence));
}

interface Hedera {
  network: string;
  mirrorNode: string;
  /** The account the app can sign with, when the run was given one. */
  signer: Wallet | null;
}

/** Mirror node reads are public, so the evaluator is told where to look and never a key. */
function hedera(): Hedera {
  return { network: network(), mirrorNode: mirrorNode(), signer: wallet() };
}

function brief(appUrl: string, chain: Hedera): string {
  return [
    "You are checking whether a running web application does what its spec says.",
    "",
    `The app is running at ${appUrl}.`,
    `It is built on Hedera ${chain.network}; the public mirror node is ${chain.mirrorNode}.`,
    ...(chain.signer === null
      ? [
          "",
          "You have no wallet. Anything needing a signature cannot be completed, and",
          "saying so is a finding — do not go looking for one.",
        ]
      : [
          "",
          `You have a funded ${chain.network} account to sign with:`,
          `  account   ${chain.signer.id}`,
          `  key       ${chain.signer.key}`,
          "",
          "Import it into the app rather than letting the app generate its own wallet,",
          "which would have no funds. How depends on the app: a burner wallet usually",
          "reads its key from browser storage — scaffolded Hedera apps use the",
          "localStorage entry `burnerWallet.pk` — and some apps offer an import field.",
          "Set it before connecting. If the app only supports a browser extension there",
          "is no way in, and that is a finding rather than something to work around.",
        ]),
    "",
    "Judge the app with what it has. Do not acquire funds, sign up for services, or",
    "obtain credentials — if the app cannot do something, that is what you report.",
    "",
    "Read spec.md, which is the only file here. Decide what a user should be able",
    "to do if the spec were satisfied, then try it against the running app:",
    "",
    "- drive the browser with `playwright-cli` through Bash (see the playwright-cli skill)",
    "- check any on-chain effect by reading the mirror node over HTTP; it is public,",
    "  and you have no keys and need none",
    `- for anything on chain, also call ${DECLARE} so the harness reads it too. Declare`,
    "  the claim **before** the action that should make it true: a change can only be",
    "  measured against a value recorded beforehand. The harness settles these itself",
    "  and does not ask you whether they held, so a claim you are unsure of is worth",
    "  declaring — it is checked, not taken on trust",
    "- save a screenshot, page snapshot or saved response into `evidence/` **as you go**,",
    "  so every finding can be checked afterwards",
    "",
    "You cannot see the source code and should not try; judge only observable behaviour.",
    "",
    "**You get one turn and nothing will resume you.** Never start a command in the",
    "background and end your turn waiting to be notified — no notification can arrive,",
    "and a turn that ends without a verdict throws the whole evaluation away. If you",
    "need to wait, wait in the foreground: a blocking command costs nothing while it",
    `runs, and you have ${WALL_CLOCK_MS / 60_000} minutes for the entire check.`,
    "",
    `When you are done, call ${TOOL} exactly once. Pass only if every requirement in the`,
    "spec is met. For each requirement that is not met, give one entry naming what a user",
    "cannot do, where it happens, and the evidence file or mirror node URL that shows it.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The Playwright CLI ships its own agent skill; loading it beats explaining the CLI. */
function playwrightSkills(): string {
  return join(HARNESS_ROOT, "node_modules", "playwright-core", "lib", "tools");
}
