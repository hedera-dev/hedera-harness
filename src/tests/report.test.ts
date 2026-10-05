import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessEvent } from "../events.js";
import { report } from "../render/report.js";

/**
 * Every run on disk passed on the first attempt, so the thing the report exists
 * to show — an agent converging, or failing to — has never happened yet. This
 * builds it: two attempts, one failure carried across both and one traded for a
 * new one, which is precisely the pair the tally is there to tell apart.
 */
const REPEATED = "c139d0a45343";

const RUN: HarnessEvent[] = [
  {
    type: "run:started",
    command: "run",
    stamp: "2026-09-17T00-00-00-000Z",
    repo: "/repo",
    spec: "/repo/specs/x.md",
    specInRepo: "specs/x.md",
    from: "main",
    head: "abcdef123456",
    model: "sonnet",
    maxAttempts: 3,
  },
  { type: "phase:started", phase: "doctor" },
  { type: "check", name: "tooling", ok: true },

  { type: "phase:started", phase: "generate", attempt: 1, detail: "sonnet" },
  { type: "tool", tool: "Write", argument: "/repo/app/page.tsx", phase: "generate", attempt: 1 },
  { type: "generate:finished", attempt: 1, turns: 20, toolCalls: 9, costUsd: 0.4, durationMs: 60_000 },
  { type: "phase:started", phase: "test", attempt: 1 },
  { type: "command:started", name: "build", command: { run: "yarn build" } },
  { type: "phase:started", phase: "evaluate", attempt: 1, detail: "blind" },
  { type: "tool", tool: "Bash", argument: "playwright-cli open http://localhost:3000", phase: "evaluate", attempt: 1 },
  { type: "evaluate:finished", attempt: 1, verdict: "fail", findings: 2, costUsd: 0.2, durationMs: 30_000 },
  {
    type: "attempt:finished",
    attempt: 1,
    passed: false,
    open: 0,
    fixed: 0,
    fresh: 2,
    failures: [
      { kind: "verdict", id: REPEATED, where: "/status", what: "shows undefined", evidence: ["a.png"] },
      { kind: "verdict", id: "0000aaaa1111", where: "#err", what: "missing", evidence: ["b.png"] },
    ],
  },

  { type: "phase:started", phase: "generate", attempt: 2, detail: "sonnet · resumed" },
  { type: "generate:finished", attempt: 2, turns: 8, toolCalls: 3, costUsd: 0.1, durationMs: 20_000 },
  { type: "phase:started", phase: "evaluate", attempt: 2, detail: "blind" },
  { type: "note", level: "warn", text: "no verdict — asking the same evaluator to finish", attempt: 2 },
  { type: "evaluate:finished", attempt: 2, verdict: "fail", findings: 2, costUsd: 0.15, durationMs: 25_000 },
  {
    type: "attempt:finished",
    attempt: 2,
    passed: false,
    open: 1,
    fixed: 1,
    fresh: 1,
    failures: [
      { kind: "verdict", id: REPEATED, where: "/status", what: "still shows undefined", evidence: ["c.png"] },
      { kind: "stage", id: "beef12345678", stage: "test", command: { run: "yarn test" }, code: 1, timedOut: false, timeoutMs: 1_200_000, error: "Error: boom", artifact: "attempt-2/test.txt" },
    ],
  },
  {
    type: "run:finished",
    passed: false,
    cancelled: false,
    attempts: 2,
    branch: "harness/2026-09-17T00-00-00-000Z",
    timings: { generateMs: 80_000, testMs: 5_000, evaluateMs: 55_000 },
    dir: "/repo/.harness/runs/2026-09-17T00-00-00-000Z",
  },
];

async function renderRun(): Promise<string> {
  return renderStream(RUN);
}

async function renderStream(stream: HarnessEvent[]): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "harness-report-"));
  const dir = join(repo, ".harness", "runs", "2026-09-17T00-00-00-000Z");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "events.jsonl"), stream.map((event) => JSON.stringify(event)).join("\n"));

  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await report({ repoRoot: repo, full: false });
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

test("a failure that survived an attempt is marked as one", async () => {
  const output = await renderRun();
  const carried = output.split("\n").find((line) => line.includes("still shows undefined"));
  assert.match(carried ?? "", /\(still open\)/, "a repeat must be visible as a repeat");
  // The one that appeared for the first time in attempt 2 must not be marked.
  const fresh = output.split("\n").find((line) => line.includes("yarn test"));
  assert.doesNotMatch(fresh ?? "", /\(still open\)/);
});

test("the tally separates converging from thrashing", async () => {
  const output = await renderRun();
  assert.match(output, /0 open · 0 fixed · 2 new/);
  assert.match(output, /1 open · 1 fixed · 1 new/);
});

test("the run's cost is the sum of every phase that spent", async () => {
  const output = await renderRun();
  // 0.4 + 0.2 + 0.1 + 0.15, and labelled a total because nothing is missing.
  assert.match(output, /\$0\.85 of tokens in total/);
});

test("an evaluator that had to be asked twice is surfaced", async () => {
  const output = await renderRun();
  assert.match(output, /no verdict — asking the same evaluator to finish/);
});

test("both attempts are shown, and the run reads as failed", async () => {
  const output = await renderRun();
  assert.match(output, /ATTEMPT 1/);
  assert.match(output, /ATTEMPT 2/);
  assert.match(output, /FAILED/);
  assert.match(output, /git switch harness\/2026-09-17T00-00-00-000Z/);
});

/**
 * Events carry their own attempt now, so a note that belongs to none of them —
 * an interrupt, a branch the run could not return to — is no longer swept into
 * whichever attempt was open. It has to be shown somewhere all the same.
 */
test("a warning that belongs to no attempt is still reported", async () => {
  const stream: HarnessEvent[] = [
    ...RUN.slice(0, 3),
    { type: "note", level: "warn", text: "\ninterrupted — cleaning up" },
    ...RUN.slice(3),
  ];
  const output = await renderStream(stream);
  assert.match(output, /interrupted — cleaning up/);
});

/**
 * The run this describes is the one the checklist exists for: the judge
 * accounted for every item, and one read out of the spec did not hold — with
 * the judge's reason for passing the run anyway, said out loud.
 */
const VERIFIED: HarnessEvent[] = [
  ...RUN.slice(0, 3),
  { type: "phase:started", phase: "evaluate", attempt: 1, detail: "blind" },
  { type: "evaluate:finished", attempt: 1, verdict: "pass", findings: 0, costUsd: 0.2, durationMs: 1000 },
  {
    type: "check:verified",
    id: "chain:accounts/0.0.2:balance.balance:atLeast=100",
    holds: true,
    before: "100",
    after: "102.5",
    attempt: 1,
  },
  {
    type: "check:verified",
    id: "http:/status:body:contains=Hedera Testnet",
    holds: false,
    after: "a page without it",
    because: "`#network-name` — the display name, `Hedera Testnet`",
    note: "the app shows it in the footer, not the named element",
    attempt: 1,
  },
  {
    type: "attempt:finished",
    attempt: 1,
    passed: true,
    open: 0,
    fixed: 0,
    fresh: 0,
    failures: [],
  },
  {
    type: "run:finished",
    passed: true,
    cancelled: false,
    attempts: 1,
    branch: "harness/x",
    timings: { generateMs: 1, testMs: 1, evaluateMs: 1 },
    dir: "/repo/.harness/runs/x",
  },
];

test("held items are counted, and one that did not hold is named with its readings", async () => {
  const output = await renderStream(VERIFIED);
  assert.match(output, /1 held · 1 did not hold/);
  assert.match(output, /http:\/status:body:contains=Hedera Testnet — a page without it/);
  assert.doesNotMatch(
    output,
    /chain:accounts\/0\.0\.2/,
    "a claim that held needs no line of its own",
  );
});

/**
 * An item that did not hold appears only here, so everything a reader needs
 * has to be here with it: the quoted line is how they tell "my app is wrong"
 * from "my spec said something I did not mean", and the note is how they know
 * which of the two the judge judged it to be.
 */
test("an item the judge overruled shows the spec's words and the judge's reason", async () => {
  const output = await renderStream(VERIFIED);
  assert.match(output, /#network-name/, "the reading itself, which the id does not carry");
  assert.match(output, /judge: the app shows it in the footer/, "the call is the judge's — made visibly");
});
