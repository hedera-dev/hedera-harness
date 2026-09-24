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
 * The run this describes is the one the whole mechanism exists to make visible:
 * the evaluator answered pass, and a claim it declared itself did not hold.
 */
const OVERRIDDEN: HarnessEvent[] = [
  ...RUN.slice(0, 3),
  { type: "phase:started", phase: "evaluate", attempt: 1, detail: "blind" },
  { type: "evaluate:finished", attempt: 1, verdict: "pass", findings: 0, costUsd: 0.2, durationMs: 1000 },
  { type: "check:settled", source: "declared", id: "chain:blocks:blocks.0.number", state: "held", attempt: 1, detail: "found 40802567" },
  { type: "check:settled", source: "declared", id: "chain:accounts/0.0.2:balance.balance", state: "failed", attempt: 1, detail: "expected at least 100, found 50" },
  { type: "check:settled", source: "declared", id: "chain:accounts/0.0.9:balance.balance", state: "errored", attempt: 1, detail: "answered 404" },
  {
    type: "attempt:finished",
    attempt: 1,
    passed: false,
    open: 0,
    fixed: 0,
    fresh: 1,
    failures: [
      { kind: "check", id: "aaaa1111bbbb", locator: "chain:accounts/0.0.2:balance.balance", detail: "expected at least 100, found 50" },
    ],
  },
  {
    type: "run:finished",
    passed: false,
    cancelled: false,
    attempts: 1,
    branch: "harness/x",
    timings: { generateMs: 1, testMs: 1, evaluateMs: 1 },
    dir: "/repo/.harness/runs/x",
  },
];

test("a verdict the harness overrode says so, loudly", async () => {
  const output = await renderStream(OVERRIDDEN);
  assert.match(output, /the harness overrode this/);
  assert.match(output, /verdict: pass/, "what the evaluator answered is still shown");
  assert.match(output, /FAILED/, "and the run is what the harness decided");
});

test("held checks are counted, unreadable ones are named", async () => {
  const output = await renderStream(OVERRIDDEN);
  assert.match(output, /1 held · 1 failed · 1 unreadable/);
  assert.match(output, /chain:accounts\/0\.0\.9.*answered 404/, "an unreadable check appears nowhere else");
  assert.doesNotMatch(
    output,
    /chain:blocks:blocks\.0\.number/,
    "a check that held needs no line of its own",
  );
});

/**
 * A check read out of the spec no longer fails the run, so the report is the
 * only place it appears — the quoted reading has to be there with it, or a
 * reader cannot tell "my app is wrong" from "my spec said something I did not
 * mean".
 */
test("a check read from the spec that did not hold quotes the line it came from", async () => {
  const stream: HarnessEvent[] = [
    ...RUN.slice(0, 11),
    {
      type: "check:settled",
      source: "derived",
      id: "http:/status:body:contains=Hedera Testnet",
      state: "failed",
      detail: "found a page without it",
      because: "`#network-name` — the display name, `Hedera Testnet`",
      attempt: 1,
    },
    ...RUN.slice(11),
  ];
  const output = await renderStream(stream);
  assert.match(output, /1 read from the spec did not hold/);
  assert.match(
    output,
    /#network-name/,
    "the reading itself, which the id does not carry",
  );
});

test("every failure says whether it was measured or judged", async () => {
  const measured = await renderStream(OVERRIDDEN);
  assert.match(measured, /measured\s+chain:accounts\/0\.0\.2/);

  const judged = await renderRun();
  assert.match(judged, /judged\s+\/status/);
});
