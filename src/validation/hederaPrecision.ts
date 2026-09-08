import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ValidationFinding } from "../types.js";

/**
 * Hedera's EVM layer speaks 18-decimal wei, but the underlying ledger only
 * has 8 decimals (tinybar): 1 tinybar == 1e10 wei. Any native-value amount
 * below 1e10 wei silently rounds to zero on a real transfer — including
 * *internal* contract-to-contract forwarded calls, not just externally
 * supplied amounts. The classic way this bites a first-time Hedera builder:
 * a refund/change computation (`msg.value - fee`, `amount - used`) forwarded
 * raw via `.call{value: ...}`/`.transfer`/`.send` produces a sub-tinybar
 * remainder that gets silently dropped instead of reverting or refunding
 * correctly, and the bug only surfaces once real value is on the line.
 *
 * This is a deterministic, best-effort static check, not a full-blown
 * dataflow analysis: it flags value-forwarding expressions that contain
 * subtraction (the shape of a refund/remainder computation) and are not
 * accompanied anywhere in the same file by a recognizable tinybar-rounding
 * safeguard. False negatives are expected (e.g. rounding done in a helper
 * imported from another file); it exists to catch the common, easy-to-miss
 * case, not to be exhaustive.
 */

const SOLIDITY_FILE_PATTERN = /\.sol$/i;

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "artifacts",
  "cache",
  "artifacts-bonzo",
  "cache-bonzo",
  "lib",
  "dist",
  ".harness",
]);

/** Value-transfer call whose value expression contains a subtraction — the shape of a refund/remainder forward. */
const RISKY_VALUE_FORWARD =
  /\.(?:call\s*\{\s*value\s*:|transfer\s*\(|send\s*\()\s*[^};]*[a-zA-Z0-9_.\])]\s*-\s*[a-zA-Z0-9_.(]/;

/** Evidence the file already accounts for tinybar (1e10 wei) granularity somewhere. */
const TINYBAR_SAFEGUARD = /1e10|tinybar|Tinybar|TINYBAR/;

export async function scanForHederaPrecisionRisks(workspacePath: string): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const solidityFiles = await collectSolidityFiles(workspacePath);

  for (const relativePath of solidityFiles) {
    const absolutePath = path.join(workspacePath, relativePath);
    const content = await readFile(absolutePath, "utf8");
    if (TINYBAR_SAFEGUARD.test(content)) continue;

    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (!RISKY_VALUE_FORWARD.test(line)) return;
      findings.push({
        id: `hedera-precision:${relativePath}:${index + 1}`,
        category: "hedera-precision",
        message: `Possible unrounded native-value forward at ${relativePath}:${index + 1}`,
        details:
          "This line forwards a computed native-value amount (a subtraction, likely a refund " +
          "or remainder) via call/transfer/send. On Hedera, the EVM's 18-decimal wei is backed " +
          "by an 8-decimal tinybar ledger (1 tinybar = 1e10 wei); any remaining amount below " +
          "1e10 wei rounds to zero on the real transfer, including internal contract-to-contract " +
          "forwards. If this amount can be non-zero but sub-tinybar, round it up to the nearest " +
          "1e10 wei before forwarding (or drop it and let the caller keep the dust). No `1e10` / " +
          "`tinybar` reference was found elsewhere in this file, so this may be unguarded.",
      });
    });
  }

  return findings;
}

async function collectSolidityFiles(workspacePath: string, current = ""): Promise<string[]> {
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
      entries = entries.concat(await collectSolidityFiles(workspacePath, relativePath));
      continue;
    }
    if (SOLIDITY_FILE_PATTERN.test(entry.name)) {
      entries.push(relativePath);
    }
  }

  return entries;
}
