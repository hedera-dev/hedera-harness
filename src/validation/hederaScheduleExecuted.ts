import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ValidationFinding } from "../types.js";

/**
 * Hedera's Schedule Service (`ScheduleCreateTransaction` /
 * `ScheduleInfoQuery`) reports whether a scheduled transaction has run via
 * `ScheduleInfo.executed`, which is `null` while the schedule is still
 * collecting signatures (or waiting for its expiration, under
 * `waitForExpiry`), and a real `Timestamp` object once it genuinely
 * executes — never a literal boolean `true`. Code that checks
 * `.executed === true` is not a rare edge case, it is *always* wrong: the
 * comparison can never be true, so the branch it guards silently never
 * runs, even after the schedule has genuinely executed. This is exactly
 * the pitfall the `hedera-schedule-service` skill (native-services-js
 * plugin, hedera-dev/hedera-skills) documents as the first thing to get
 * right, confirmed live against real Hedera testnet: sign a schedule to
 * completion, and `.executed === true` still reads `false`.
 *
 * This is a deterministic, best-effort static check, not a full-blown
 * dataflow analysis: it flags the literal `.executed === true` (or `==
 * true`) comparison, scoped to files that actually import a Hedera SDK
 * (`@hiero-ledger/sdk` or its predecessor package name `@hashgraph/sdk`),
 * so it does not flag an unrelated `executed` boolean on some other object
 * shape a generated app happens to define. False negatives are expected
 * (e.g. the comparison split across a helper function in another file); it
 * exists to catch the common, easy-to-miss shape, not to be exhaustive.
 */

const SCRIPT_FILE_PATTERN = /\.(?:ts|tsx|js|jsx|mts|cts)$/i;

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "artifacts",
  "cache",
  "dist",
  "build",
  ".next",
  ".harness",
]);

/** Evidence the file actually uses a Hedera SDK, not just a coincidentally-named `executed` field. */
const HEDERA_SDK_IMPORT = /from\s+["']@hiero-ledger\/sdk["']|from\s+["']@hashgraph\/sdk["']|require\(\s*["']@(?:hiero-ledger|hashgraph)\/sdk["']\s*\)/;

/** `.executed === true` / `.executed == true`, with or without spaces, either equality operator. */
const RISKY_EXECUTED_CHECK = /\.executed\s*={2,3}\s*true\b/;

export async function scanForHederaScheduleExecutedRisks(
  workspacePath: string,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const scriptFiles = await collectScriptFiles(workspacePath);

  for (const relativePath of scriptFiles) {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = await readFile(absolutePath, "utf8");
    if (!HEDERA_SDK_IMPORT.test(content)) continue;

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (!RISKY_EXECUTED_CHECK.test(line)) return;
      findings.push({
        id: `hedera-schedule-executed:${relativePath}:${index + 1}`,
        category: "hedera-schedule-executed",
        message: `Possible incorrect ScheduleInfo.executed check at ${relativePath}:${index + 1}`,
        details:
          "This line compares something ending in `.executed` against the literal `true`. " +
          "Hedera's ScheduleInfo.executed is `null` until a scheduled transaction runs and a " +
          "real Timestamp object once it does — it is never the boolean `true`, so a `=== true` " +
          "(or `== true`) comparison can never pass, even after the schedule genuinely executed. " +
          "Check executed-ness by testing for non-null instead (e.g. `info.executed !== null`), " +
          "and derive an actual timestamp with `info.executed.toDate()` if one is needed.",
      });
    });
  }

  return findings;
}

async function collectScriptFiles(workspacePath: string, current = ""): Promise<string[]> {
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
      entries = entries.concat(await collectScriptFiles(workspacePath, relativePath));
      continue;
    }
    if (SCRIPT_FILE_PATTERN.test(entry.name)) {
      entries.push(relativePath);
    }
  }

  return entries;
}
