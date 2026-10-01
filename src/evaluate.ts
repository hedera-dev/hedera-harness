import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { type Check, worded } from "./checks.js";
import { emit } from "./events.js";
import { type Wallet, mirrorNode, network, redact, wallet } from "./wallet.js";
import { describeMessage, endingOf, said } from "./messages.js";
import type { Run } from "./run.js";

/**
 * How long judging one spec may take. The bound that is actually ours to set:
 * a run has to end, and this is the only number here that is about the harness
 * rather than about the operator's wallet.
 *
 * Nine runs measured the rest. A `send-hbar` evaluation ended at
 * `error_max_turns` on turn 121 having spent $2.51 of its $5 in 13 of its 20
 * minutes — so the bound that fired was a turn count nobody had chosen for any
 * reason, while the two picked deliberately sat unused. It cost a verdict.
 */
const WALL_CLOCK_MS = 45 * 60_000;

/** Measured: 13.4 minutes across the 121 turns of a real evaluation. */
const SECONDS_PER_TURN = 6.7;

/**
 * Turns exist to end a loop that is going nowhere *cheaply* — one that spends
 * nothing and takes no time per turn would otherwise run to the wall clock. So
 * it is derived to expire just after the clock rather than before it, which is
 * the mistake the measurement caught.
 */
const MAX_TURNS = Math.ceil(WALL_CLOCK_MS / 1_000 / SECONDS_PER_TURN);

/** What the evaluator writes, in its own workspace, and the harness reads back. */
const VERDICT_FILE = "verdict.json";
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

/**
 * The judge's accounting of one checklist item. The harness never reads the
 * values — it requires that they exist, that the evidence behind them does,
 * and that a claim reported as not held is reconciled with the verdict.
 */
export interface Verified {
  /** The checklist item's id, copied from the brief. */
  id: string;
  /** What a chain item answered before the judge touched the app. */
  before?: string | undefined;
  /** What it answered after — or what the element shows, for a page item. */
  after: string;
  holds: boolean;
  /** Mirror node URLs or files in `evidence/` that show the readings. */
  evidence: string[];
  /** When the claim did not hold but the run passes: how the item misread the spec. */
  note?: string | undefined;
}

export interface Verdict {
  pass: boolean;
  failures: Failure[];
  /** One entry per checklist item in the brief. Empty when there were none. */
  verified: Verified[];
}

/**
 * Either the evaluator answered, or it did not. There is no third state: a
 * well-formed verdict is final and is never re-rolled, while "no verdict"
 * means exactly the cases below and earns one retry.
 */
export type Outcome =
  | { type: "verdict"; verdict: Verdict }
  | { type: "no-verdict"; reason: string; why: Unanswered };

/**
 * The ways an evaluation ends without an answer, which need different
 * things said to them. Matching on the reason's prose would work until someone
 * reworded it.
 */
export type Unanswered =
  /** A bound stopped it: it had not decided it was finished. */
  | "cut-off"
  /** It ended its own turn without calling the tool. */
  | "unreported"
  /** It answered, but cited evidence that is not on disk. */
  | "unevidenced"
  /** It answered without accounting for every checklist item. */
  | "incomplete";

export interface EvaluateOptions {
  repoRoot: string;
  /** Read from the spec at DOCTOR, before the app existed. The judge must account for every one. */
  checks: Check[];
  run: Run;
  specPath: string;
  attempt: number;
  model: string;
  appUrl: string;
  /** Unset means no spend ceiling — the wall clock is what bounds a run. */
  maxSpendUsd?: number | undefined;
}

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

  const captured: Captured = { verdict: null, malformed: null };
  const chain = hedera();
  const transcript = await run.path(`attempt-${attempt}`, "evaluate.jsonl");

  emit({
    type: "phase:started",
    phase: "evaluate",
    attempt,
    detail: `${options.model} · blind · ${appUrl}`,
  });

  let { outcome, sessionId } = await pass(options, workspace, transcript, {
    prompt: brief(appUrl, chain, options.checks),
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
    ({ outcome } = await pass(options, workspace, transcript, {
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

  // The verdict is the judge's, full stop — the harness never reads the chain
  // to confirm it. What it records is the accounting: each checklist item, both
  // of the judge's readings, and whether the claim held, so the report can show
  // the working rather than the conclusion.
  if (outcome.type === "verdict") {
    for (const entry of outcome.verdict.verified) {
      const check = options.checks.find((item) => item.id === entry.id);
      emit({
        type: "check:verified",
        id: entry.id,
        holds: entry.holds,
        before: entry.before,
        after: entry.after,
        note: entry.note,
        because: check?.because,
        attempt,
      });
    }
    await writeFile(
      await run.path(`attempt-${attempt}`, "verdict.json"),
      `${JSON.stringify({ ...outcome.verdict, judgedBy: options.model }, null, 2)}\n`,
    );
  }

  // Evidence is collected whatever the outcome — a run that produced no verdict
  // is exactly when you want to see what the evaluator was looking at.
  await cp(join(workspace, "evidence"), await run.path(`attempt-${attempt}`, "evidence"), {
    recursive: true,
  });

  return outcome;
}

interface Captured {
  verdict: Verdict | null;
  malformed: string | null;
}

/**
 * One turn of the evaluator, bounded on its own. Returns what the harness makes
 * of it — a verdict, or one of the three ways there is not one.
 */
async function pass(
  options: EvaluateOptions,
  workspace: string,
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

  // A verdict from the previous pass must not be mistaken for this one's: the
  // retry exists precisely because the last attempt did not answer properly.
  await rm(join(workspace, VERDICT_FILE), { force: true });

  try {
    const conversation = query({
      prompt: turn.prompt,
      options: {
        cwd: workspace,
        model: options.model,
        ...(turn.resume === undefined ? {} : { resume: turn.resume }),
        plugins: [{ type: "local", path: playwrightSkills() }],
        // `settingSources: []` blocks the operator's own skills and plugins but
        // not the ones Claude Code bundles, which arrive regardless: measured at
        // fifteen reaching the evaluator, of which one is wanted. Bloat is the
        // lesser half. Several of the rest — code-review, security-review,
        // simplify, run, init — point a judge at the code, which is the one
        // thing this stage may never look at.
        skills: [driving()],
        settingSources: [],
        permissionMode: "bypassPermissions",
        sandbox: {
          enabled: true,
          // A missing seatbelt or bubblewrap must abort, never silently
          // downgrade to an unsandboxed evaluator.
          failIfUnavailable: true,
          filesystem: contained(workspace, repoRoot),
          // The evaluator has to reach the app it is judging, and the app is on
          // a loopback port. Without this the sandbox refuses the connection —
          // both families, so it is not a localhost-resolves-to-IPv6 problem —
          // and the agent's own recovery is to rerun the command with its
          // sandbox switched off. Granting the one thing it needs is better
          // than a containment the agent routes around. External egress was
          // never blocked; it reads the mirror node in the same session.
          network: { allowLocalBinding: true },
        },
        maxTurns: MAX_TURNS,
        // Only when asked for. See `--max-spend`.
        ...(options.maxSpendUsd === undefined ? {} : { maxBudgetUsd: options.maxSpendUsd }),
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

  // The answer is on disk, not in a tool handler. Read after the turn rather
  // than during it: there is nothing the harness can do with a verdict until
  // the evaluator has stopped working on it.
  turn.captured.verdict = await readVerdict(workspace);

  const outcome = adjudicate(turn.captured, workspace, options.checks);
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

/**
 * Reads the verdict the evaluator wrote.
 *
 * This was an MCP tool, and the schema it carried is now described in the brief
 * instead. One thing does not survive the move: the tool returned
 * `_meta: {"claude/endTurn": true}`, so answering ended the turn. A file cannot
 * do that, which means an evaluator may keep working after it has answered.
 * With turns derived from the wall clock that costs little, and it is the only
 * capability given up here.
 *
 * A file that is absent, unparseable or the wrong shape all mean the same
 * thing to the caller — no verdict — which earns the one retry.
 */
async function readVerdict(workspace: string): Promise<Verdict | null> {
  const source = await readFile(join(workspace, VERDICT_FILE), "utf8").catch(() => null);
  if (source === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const { pass, failures, verified } = parsed as Record<string, unknown>;
  if (typeof pass !== "boolean") return null;

  return {
    pass,
    failures: asArray(failures).flatMap((entry) => {
      const failure = asFailure(entry);
      return failure === null ? [] : [failure];
    }),
    verified: asArray(verified).flatMap((entry) => {
      const item = asVerified(entry);
      return item === null ? [] : [item];
    }),
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Evidence is normalised on the way in, as the tool handler used to do. */
function evidenceOf(value: unknown): string[] {
  return asArray(value)
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .map(cited);
}

function asFailure(entry: unknown): Failure | null {
  if (entry === null || typeof entry !== "object") return null;
  const { what, where, evidence } = entry as Record<string, unknown>;
  if (typeof what !== "string" || what === "") return null;
  if (typeof where !== "string" || where === "") return null;
  const cited = evidenceOf(evidence);
  return cited.length === 0 ? null : { what, where, evidence: cited };
}

function asVerified(entry: unknown): Verified | null {
  if (entry === null || typeof entry !== "object") return null;
  const { id, before, after, holds, evidence, note } = entry as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof holds !== "boolean") return null;
  if (typeof after !== "string" || after === "") return null;
  return {
    id,
    ...(typeof before === "string" && before !== "" ? { before } : {}),
    after,
    holds,
    evidence: evidenceOf(evidence),
    ...(typeof note === "string" && note !== "" ? { note } : {}),
  };
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
  const findings = verdict.failures.map((failure) => failure.where);
  // Whether a claim held is a finding too — an evidence-fixing retry that
  // flips one has changed the verdict, which is the one thing it may not do.
  const claims = verdict.verified.map((entry) => `${entry.id}=${entry.holds}`);
  return [...findings, ...claims].sort().join(", ");
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
      `evidence is still in evidence/ — and only then write ${VERDICT_FILE}.`,
      "Do not pass a requirement you have not actually checked.",
    ],
    unreported: [
      `You did the work and ended without reporting it. Write ${VERDICT_FILE} now`,
      `with what`,
      "you found. Check anything you are unsure of first.",
    ],
    unevidenced: [
      "Your verdict cited evidence the harness cannot find. Save the files you",
      "meant to cite into evidence/, or cite only files that are there, and call",
      `write ${VERDICT_FILE} again. A finding nobody can check is not a finding.`,
      "",
      "Report the same findings. You are fixing how they are evidenced, not",
      "whether they stand — the app has not changed since you looked at it.",
    ],
    incomplete: [
      "Your verdict left checklist items unaccounted for. Read the ones you",
      "skipped — the checklist is in the brief, and your browser and session are",
      `still live — then write ${VERDICT_FILE} again. This is the reading you have not`,
      "done, not a re-reading: your other findings stand unless what you read",
      "now contradicts them.",
    ],
  }[outcome.why];
  return [...opening, ...closing].join("\n");
}

/**
 * The ways there is no verdict: the evaluator never called the tool, the
 * payload was not usable, it cited evidence that is not on disk, or it left
 * the checklist partly unaccounted for. Anything else the evaluator says is
 * an answer, and answers stand.
 */
export function adjudicate(
  captured: { verdict: Verdict | null; malformed: string | null },
  workspace: string,
  checks: Check[],
): Outcome {
  if (captured.malformed !== null) {
    return { type: "no-verdict", reason: captured.malformed, why: "cut-off" };
  }
  if (captured.verdict === null) {
    return {
      type: "no-verdict",
      reason: `the evaluator finished without writing ${VERDICT_FILE}`,
      why: "unreported",
    };
  }
  const verdict = captured.verdict;

  const missing = [
    ...verdict.failures.flatMap((failure) => failure.evidence),
    ...verdict.verified.flatMap((entry) => entry.evidence),
  ].filter((evidence) => !resolves(evidence, workspace));

  if (missing.length > 0) {
    return {
      type: "no-verdict",
      reason:
        `the verdict cites evidence that is not there: ${missing.join(", ")}. ` +
        `A finding the harness cannot see is not a finding.`,
      why: "unevidenced",
    };
  }

  // The accounting is the mechanical part. The harness cannot tell whether a
  // reading is true — it can tell whether there is one, and a verdict that
  // skips an item is a verdict about work the judge did not do.
  const unaccounted = checks.filter((check) => {
    const entry = verdict.verified.find((candidate) => candidate.id === check.id);
    if (entry === undefined) return true;
    // A chain claim without its "before" is a state, not a change.
    return check.kind === "chain" && entry.before === undefined;
  });
  if (unaccounted.length > 0) {
    return {
      type: "no-verdict",
      reason:
        `the verdict does not account for every checklist item: ` +
        `${unaccounted.map((check) => check.id).join(", ")}`,
      why: "incomplete",
    };
  }

  // A pass over an item the judge itself reported as not holding is a
  // contradiction — unless the item misread the spec, which is the judge's
  // call to make out loud, not to make silently.
  const unexplained = verdict.verified.filter((entry) => !entry.holds && entry.note === undefined);
  if (verdict.pass && unexplained.length > 0) {
    return {
      type: "no-verdict",
      reason:
        `the verdict passes but reports ${unexplained.map((entry) => entry.id).join(", ")} ` +
        `as not holding. Either the run fails, or the item misread the spec — say how in \`note\`.`,
      why: "incomplete",
    };
  }

  return { type: "verdict", verdict };
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

function brief(appUrl: string, chain: Hedera, checks: Check[]): string {
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
    "  and you have no keys and need none. Read it **before** the action that should",
    "  change it and again after — a change is only visible against a value you wrote",
    "  down beforehand, and both readings belong in your evidence",
    "- save a screenshot, page snapshot or saved response into `evidence/` **as you go**,",
    "  so every finding can be checked afterwards",
    "",
    ...(checks.length === 0
      ? []
      : [
          "This checklist was read out of the spec before the app existed, so nothing",
          "about the app could have shaped it. Account for every item. For chain items:",
          "read the path from the mirror node **before you touch the app** and again",
          "afterwards — the first reading is what the second is measured against. For",
          "page items: check them in the browser you have open.",
          "",
          ...checks.map((check) => worded(check)),
          "",
          "Every item needs one `verified` entry: its id, what you read",
          "(before, for chain items, and after), whether it held, and the URL or",
          "evidence file that shows it. An item that did not hold normally means the",
          "run fails; if the item misread the spec, say how in `note` and judge the",
          "spec itself.",
          "",
        ]),
    "You cannot see the source code and should not try; judge only observable behaviour.",
    "",
    "**You get one turn and nothing will resume you.** Never start a command in the",
    "background and end your turn waiting to be notified — no notification can arrive,",
    "and a turn that ends without a verdict throws the whole evaluation away. If you",
    "need to wait, wait in the foreground: a blocking command costs nothing while it",
    `runs, and you have ${WALL_CLOCK_MS / 60_000} minutes for the entire check.`,
    "",
    `When you are done, write your verdict to ${VERDICT_FILE} in this directory, as`,
    "JSON and nothing else — no prose around it, no markdown fence:",
    "",
    "    {",
    '      "pass": false,',
    '      "failures": [',
    '        { "what": "what a user cannot do, in their terms",',
    '          "where": "a bare locator: /send, or #result",',
    '          "evidence": ["shot.png", "https://testnet.mirrornode.hedera.com/..."] }',
    "      ],",
    '      "verified": [',
    '        { "id": "<the checklist id, copied exactly>",',
    '          "before": "100", "after": "102.5", "holds": true,',
    '          "evidence": ["https://testnet.mirrornode.hedera.com/..."],',
    '          "note": "only when it did not hold but the run still passes" }',
    "      ]",
    "    }",
    "",
    "Pass only if every requirement in the spec is met. `where` is a bare locator and",
    "nothing else — no sentences; the explanation belongs in `what`. Every entry in",
    "`evidence` is a filename you saved in evidence/ or a mirror node URL, nothing else.",
    "`before` is for chain items only. Writing that file is how you answer; nothing",
    "else counts as answering.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * What the evaluator may read, and everything it may not.
 *
 * The plan has always said "deny rules for everything outside that directory".
 * The code denied two of them — the repo and the harness — which made the
 * blindness that matters real and left the claim wider than the code. `allowRead`
 * is not a standalone allowlist: the SDK defines it as paths re-allowed *within*
 * denied regions, so the only way to express "everything else" is to deny a
 * region and punch holes in it.
 *
 * The region is the home directory, because that is where a person's secrets
 * live — keys, tokens, other clients' repositories. System paths are not denied:
 * an agent that cannot read `/usr/bin` cannot run anything, and `/usr/bin` holds
 * nothing worth hiding.
 *
 * The holes are the three things an evaluator genuinely needs from home: its own
 * credentials, the browser it drives, and the CLI that drives it. Each is here
 * because removing it breaks evaluation, not because it seemed harmless.
 */
/** Exported for tests: the rules themselves, since the sandbox cannot be asserted on. */
export function contained(workspace: string, repoRoot: string) {
  return {
    denyRead: [homedir(), repoRoot, HARNESS_ROOT],
    allowRead: [
      workspace,
      // Authentication. Denying this logs the evaluator out of itself.
      join(homedir(), ".claude"),
      // The browser, and the binary that launches it.
      browserCache(),
      join(HARNESS_ROOT, "node_modules", ".bin"),
      join(HARNESS_ROOT, "node_modules", "playwright-core"),
    ],
  };
}

/** Playwright's documented cache locations, and the variable that overrides them. */
export function browserCache(): string {
  const override = process.env["PLAYWRIGHT_BROWSERS_PATH"];
  if (override !== undefined) return override;
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "ms-playwright");
  if (process.platform === "win32") return join(homedir(), "AppData", "Local", "ms-playwright");
  return join(homedir(), ".cache", "ms-playwright");
}

/**
 * The Playwright CLI ships its own agent skill; loading it beats explaining the
 * CLI. A local plugin is the only way the SDK takes a skill directory — the
 * `skills` option filters what was found, it does not find anything.
 */
function playwrightSkills(): string {
  return join(HARNESS_ROOT, "node_modules", "playwright-core", "lib", "tools");
}

/**
 * The one skill the evaluator should have, qualified by plugin name. That name
 * comes from the directory, so it is read from the path rather than written out
 * twice — the alternative is a literal that stops matching if Playwright moves
 * the folder, and a filter that matches nothing leaves the evaluator with no
 * browser skill and no complaint.
 *
 * The same directory also ships `playwright-component-testing` and
 * `playwright-trace`, which have nothing to do with judging a running app.
 */
function driving(): string {
  return `${basename(playwrightSkills())}:playwright-cli`;
}
