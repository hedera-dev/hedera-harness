import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ValidationFinding } from "../types.js";

/**
 * On Hedera, `block.timestamp` is the *consensus* timestamp the network
 * assigns; the EVM block is a synthetic view over consensus rounds, and there
 * is no local node whose clock the developer controls. The usual EVM escape
 * hatch is also missing: the JSON-RPC relay exposes only the `admin`, `debug`,
 * `eth`, `net`, `trace` and `txpool` namespaces, so `evm_increaseTime` and
 * `evm_setNextBlockTimestamp` do not exist against testnet and anything
 * unlisted answers `-32601`. Deprived of time travel, generated code reaches
 * for a real sleep on the local clock:
 *
 *     while (Date.now() / 1000 < deadline) await sleep(1_000);
 *     await sleep(1_000);                    // "a second extra, to be safe"
 *     await pools.settle(poolId);            // reverts if consensus disagrees
 *
 * The two clocks are normally fractions of a second apart, so this passes
 * almost always and fails rarely — which is what lets it survive review. When
 * it does fail the cost is not a flaky assertion: the next transaction
 * reverts, and in a multi-step flow the revert unwinds every step queued
 * behind it, which can strand funds with nothing left in the run to recover
 * them. The fix is to ask the network whether the deadline passed — a bounded
 * poll of contract or mirror-node state — rather than to assume it.
 *
 * This is a deterministic, best-effort static check, not dataflow analysis.
 * It anchors narrowly on purpose: a wait whose duration is computed from a
 * deadline-ish value *using the local clock*, followed by a contract call,
 * with no intervening read of network state. False negatives are expected and
 * preferred — a check that fires on correct code is worse than no check.
 */

const SCANNED_FILE_PATTERN = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  "artifacts",
  "cache",
  "typechain",
  "typechain-types",
  ".harness",
  ".harness-context",
  ".harness-skills",
  ".harness-semantic",
  ".skill-cache",
]);

/** How far past the wait we look for the call it was waiting to make. */
const FORWARD_WINDOW_LINES = 25;

/**
 * Beyond this, a line is minified or generated rather than written, and a
 * line-oriented check cannot reason about it: a single bundle line holds a
 * whole module, so the clock, the deadline and an unrelated call all collide
 * on it. Such lines are treated as opaque instead of as evidence.
 */
const MAX_ANALYZED_LINE_LENGTH = 500;

/** A read of the machine's own clock — the thing consensus does not agree with. */
const LOCAL_CLOCK =
  /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\([^)]*\)\s*\.\s*getTime\s*\(|\bperformance\s*\.\s*now\s*\(/;

/** A value representing a moment the contract will compare against consensus. */
const DEADLINE_TOKEN =
  /(?:deadline|expiry|expires_?at|expiration|expires\b|end_?time|ends_?at|closes_?at|close_?time|unlock_?time|valid_?until|not_?after|maturity)/i;

/** A construct that burns wall-clock time. `tx.wait()` is deliberately absent. */
const SLEEP_CALL = /\bsetTimeout\s*\(|\bsleep\s*\(|\bdelay\s*\(|\bpause\s*\(|\bsetInterval\s*\(/;

const LOOP_HEAD = /\b(?:while|for)\s*\(/;

/** `const remaining = () => deadline - Math.floor(Date.now() / 1000)` */
const BINDING_NAME = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/;

/**
 * Evidence the code asks the network instead of assuming. Any of these between
 * the wait and the call means the wait is part of a real poll, so we stay
 * quiet.
 */
const NETWORK_READ = new RegExp(
  [
    /\.\s*(?:staticCall|callStatic|queryFilter)\b/.source,
    /\b(?:ContractCallQuery|AccountBalanceQuery|AccountInfoQuery|TopicMessageQuery|ContractInfoQuery)\b/.source,
    /\bmirror\w*\s*[.(]/.source,
    /\/api\/v1\//.source,
    /\bprovider\s*\.\s*(?:call|getBlock|getBlockNumber|getStorage|getStorageAt|getLogs|getTransactionReceipt|getCode)\b/
      .source,
    /\b(?:statusOf|getStatus|readStatus|getState|stateOf|isExpired|hasExpired|isClosed|isSettled|isOpen|getDeadline|deadlineOf|getPhase|phaseOf|refresh|poll)\s*\(/
      .source,
  ].join("|"),
  "i",
);

/** Bookkeeping around the wait that is not the deadline-gated call itself. */
const NON_CHAIN_CALL =
  /\b(?:console|logger|log|report|reporter|assert|expect|chai|fs|fsp|path|JSON|Math|process|test|it|describe|sleep|delay|pause|setTimeout|setInterval|clearTimeout|clearInterval)\b/;

/** Unambiguous state-changing calls, which count even inside a noisy line. */
const EXPLICIT_WRITE =
  /\.\s*wait\s*\(|\b(?:ContractExecuteTransaction|TransferTransaction|TokenMintTransaction|TokenBurnTransaction|TopicMessageSubmitTransaction|ContractCreateFlow)\b|\.\s*execute\s*\(\s*client/i;

/** Any awaited member call — the generous half of the trigger. */
const AWAITED_CALL = /\bawait\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)+\s*\(/;

export async function scanForConsensusDeadlineWaits(workspacePath: string): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const sourceFiles = await collectSourceFiles(workspacePath);

  for (const relativePath of sourceFiles) {
    const content = await readFile(path.join(workspacePath, relativePath), "utf8");
    findings.push(...scanSource(relativePath, content));
  }

  return findings;
}

/** Exported for tests: the whole check over one file's text, no filesystem. */
export function scanSource(relativePath: string, content: string): ValidationFinding[] {
  const lines = blankBlockComments(content).split("\n").map(stripLineComment);
  const clockAliases = collectClockAliases(lines);
  const findings: ValidationFinding[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!isDeadlineWait(lines, index, clockAliases)) continue;

    const callLine = findGatedCall(lines, index);
    if (callLine === undefined) continue;

    findings.push({
      id: `hedera-consensus-time:${relativePath}:${index + 1}`,
      category: "hedera-consensus-time",
      message: `Waits for a deadline on the local clock at ${relativePath}:${index + 1}`,
      details:
        "This wait derives its duration from a deadline value and the local clock, and the call at " +
        `${relativePath}:${callLine + 1} runs once it finishes, with no read of network state in between. ` +
        "On Hedera the contract resolves a deadline against the consensus timestamp the network assigns, " +
        "not against this machine's clock, and the relay offers no `evm_increaseTime` / " +
        "`evm_setNextBlockTimestamp` to move it. A local clock running even slightly ahead means the " +
        "network still considers the deadline open, so the call reverts — and in a multi-step flow that " +
        "revert unwinds the steps queued behind it. Ask the network instead: poll the contract or the " +
        "mirror node for the state the deadline was supposed to produce, bounded by an attempt limit, " +
        "and act on what the read actually returns.",
    });
  }

  return findings;
}

/**
 * Names bound to an expression mixing the local clock with a deadline, so that
 * `while (remaining() > 0)` is recognised as a clock comparison a line later.
 */
function collectClockAliases(lines: string[]): Set<string> {
  const aliases = new Set<string>();

  for (const line of lines) {
    if (!LOCAL_CLOCK.test(line) || !DEADLINE_TOKEN.test(line)) continue;
    const name = BINDING_NAME.exec(line)?.[1];
    if (name) aliases.add(name);
  }

  return aliases;
}

/** Does this wait's condition or argument compare the local clock to a deadline? */
function comparesClockToDeadline(text: string, clockAliases: Set<string>): boolean {
  if (LOCAL_CLOCK.test(text) && DEADLINE_TOKEN.test(text)) return true;
  return [...clockAliases].some(alias => new RegExp(`\\b${escapeIdentifier(alias)}\\b`).test(text));
}

/**
 * Two shapes count as a deadline wait: a loop that sleeps while the clock is
 * short of the deadline, and a single sleep whose duration is computed from
 * one.
 */
function isDeadlineWait(lines: string[], index: number, clockAliases: Set<string>): boolean {
  const line = lines[index];
  if (line.length > MAX_ANALYZED_LINE_LENGTH) return false;

  if (LOOP_HEAD.test(line) && comparesClockToDeadline(line, clockAliases)) {
    // The sleeping body may sit on the loop line itself or just below it.
    const body = lines.slice(index, Math.min(index + 3, lines.length)).join("\n");
    if (SLEEP_CALL.test(body)) return true;
  }

  // A sleep whose duration is computed here, rather than a fixed propagation
  // pause: the deadline and the clock both have to appear in this line.
  if (SLEEP_CALL.test(line) && LOCAL_CLOCK.test(line) && DEADLINE_TOKEN.test(line)) return true;

  return false;
}

/**
 * The call the wait was waiting to make, or undefined when a network read
 * intervenes (the code polls, so it is fine) or nothing chain-shaped follows.
 */
function findGatedCall(lines: string[], waitIndex: number): number | undefined {
  const limit = Math.min(waitIndex + 1 + FORWARD_WINDOW_LINES, lines.length);

  for (let index = waitIndex + 1; index < limit; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    // Unreadable line: stop rather than guess what it contains.
    if (line.length > MAX_ANALYZED_LINE_LENGTH) return undefined;

    // A read of network state means this wait is part of a poll rather than an
    // assumption. Stop looking; this site is not a finding.
    if (NETWORK_READ.test(line)) return undefined;

    // Leaving the enclosing function means the call is not gated by this wait.
    if (/^(?:\}|\s*(?:export|function|async\s+function)\b)/.test(line)) return undefined;

    if (EXPLICIT_WRITE.test(line)) return index;
    if (AWAITED_CALL.test(line) && !NON_CHAIN_CALL.test(line)) return index;
  }

  return undefined;
}

/**
 * Blank out `/* ... *\/` spans while preserving line count, so the worked
 * example in a doc comment above a helper is not read as the helper's code.
 */
function blankBlockComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, " "));
}

/**
 * Line comments — enough to keep a commented-out example from firing. The line
 * is walked rather than searched so that a `//` inside a string literal (a URL,
 * almost always) is left alone while a genuine trailing comment after one is
 * still cut. Quotes left open at end of line — an apostrophe in JSX text, a
 * template literal spanning lines — swallow the rest of the line, which keeps
 * the comment in the scan; that is the conservative direction.
 */
function stripLineComment(line: string): string {
  let quote: string | undefined;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "/" && line[index + 1] === "/") return line.slice(0, index);
  }

  return line;
}

function escapeIdentifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function collectSourceFiles(workspacePath: string, current = ""): Promise<string[]> {
  const absoluteCurrent = path.join(workspacePath, current);
  let entries: string[] = [];

  let dirEntries;
  try {
    dirEntries = await readdir(absoluteCurrent, { withFileTypes: true });
  } catch {
    return entries;
  }

  for (const entry of dirEntries) {
    const relativePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      entries = entries.concat(await collectSourceFiles(workspacePath, relativePath));
      continue;
    }
    if (SCANNED_FILE_PATTERN.test(entry.name)) {
      entries.push(relativePath);
    }
  }

  return entries;
}
