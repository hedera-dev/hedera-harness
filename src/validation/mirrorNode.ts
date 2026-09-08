import type { ValidationFinding } from "../types.js";

/**
 * Tier 3.5 on-chain verification: ask the mirror node what actually happened.
 *
 * Why this exists as a deterministic gate rather than a claim in a prompt:
 *
 * On Hedera, `transaction.execute(client)` is a **pre-check**. It returns once a
 * node accepts the transaction for submission, which is *before* consensus. A
 * transaction that is well-formed but fails at consensus — `CONTRACT_REVERT_EXECUTED`,
 * `INSUFFICIENT_GAS`, `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`, `INVALID_SIGNATURE` — is
 * only observable through `getReceipt()`, which most deploy scripts never call.
 *
 * So a deploy script can print "deployed!", exit 0, and have deployed nothing.
 * `runChainDeploy` checks the exit code; the exit code is not the truth. The
 * mirror node is. This gate closes that gap: after the deploy commands run, it
 * reads the ephemeral signer's transaction history and fails the attempt if the
 * chain disagrees with the exit code.
 *
 * The mirror node is eventually consistent (a second or two behind consensus),
 * so this polls rather than reading once.
 *
 * Deliberately implemented over plain REST + `fetch`: `@hiero-ledger/sdk` is an
 * optional peer dependency, and a correctness gate should not be the thing that
 * requires it. `fetchImpl` is injectable so the tests are hermetic.
 */

export type MirrorNetwork = "testnet" | "mainnet" | "previewnet";

const MIRROR_NODE_URLS: Record<MirrorNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

/** Consensus results that mean "the transaction reached consensus and worked". */
const SUCCESS_RESULTS = new Set(["SUCCESS", "SUCCESS_BUT_MISSING_EXPECTED_OPERATION"]);

/** Transaction types that create an entity whose id we can assert on. */
const CREATE_TYPES = new Set([
  "CONTRACTCREATEINSTANCE",
  "CONTRACTCREATETRANSACTION",
  "TOKENCREATION",
  "TOKENCREATE",
  "CONSENSUSCREATETOPIC",
  "FILECREATE",
]);

export interface MirrorTransaction {
  transactionId: string;
  /** e.g. CRYPTOTRANSFER, CONTRACTCALL, CONTRACTCREATEINSTANCE, TOKENCREATION. */
  name: string;
  /** Consensus status: SUCCESS, CONTRACT_REVERT_EXECUTED, INSUFFICIENT_GAS, … */
  result: string;
  consensusTimestamp: string;
  /** Entity created or acted on, when the mirror node reports one. */
  entityId?: string;
  chargedFeeHbar: number;
}

export interface MirrorNodeGateOptions {
  /** The ephemeral signer provisioned for this run (0.0.x), or its EVM address. */
  accountId: string;
  network?: MirrorNetwork;
  /** Override the mirror node base URL (no trailing slash). */
  mirrorNodeUrl?: string;
  /**
   * Only count transactions at or after this consensus timestamp (`seconds.nanos`).
   * Pass the run's start so a reused signer's earlier history is not credited.
   */
  since?: string;
  /** Fail if fewer than this many transactions are found. Default 1. */
  minTransactions?: number;
  /** Give up polling after this long. Default 30s. */
  timeoutMs?: number;
  /** Poll interval. Default 2s. */
  pollMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MirrorNodeGateResult {
  /** False when the mirror node could not be reached — infrastructure, not an app defect. */
  reachable: boolean;
  transactions: MirrorTransaction[];
  /** Transactions that reached consensus with a non-success status. */
  failures: MirrorTransaction[];
  /** Entity ids created during the window (contracts, tokens, topics). */
  entitiesCreated: string[];
  findings: ValidationFinding[];
}

/** Public mirror node base URL for a network. */
export function mirrorNodeUrlFor(network: MirrorNetwork = "testnet"): string {
  return MIRROR_NODE_URLS[network];
}

/** `1788858113.004209110` → comparable bigint of nanoseconds since epoch. */
function toNanos(consensusTimestamp: string): bigint {
  const [seconds, nanos = "0"] = consensusTimestamp.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0"));
}

interface RawMirrorTransaction {
  transaction_id?: string;
  name?: string;
  result?: string;
  consensus_timestamp?: string;
  entity_id?: string | null;
  charged_tx_fee?: number;
}

function normalize(raw: RawMirrorTransaction): MirrorTransaction {
  return {
    transactionId: raw.transaction_id ?? "(unknown)",
    name: raw.name ?? "(unknown)",
    result: raw.result ?? "(unknown)",
    consensusTimestamp: raw.consensus_timestamp ?? "0.0",
    ...(raw.entity_id ? { entityId: raw.entity_id } : {}),
    chargedFeeHbar: (raw.charged_tx_fee ?? 0) / 100_000_000,
  };
}

/**
 * Read the signer's transactions from the mirror node, polling until at least
 * `minTransactions` appear or the timeout elapses.
 *
 * Returns `reachable: false` rather than throwing when the mirror node is down:
 * an outage is a harness-infrastructure problem, and failing the generated app
 * for it would be wrong.
 */
export async function readSignerTransactions(
  options: MirrorNodeGateOptions,
): Promise<{ reachable: boolean; transactions: MirrorTransaction[]; error?: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.mirrorNodeUrl ?? mirrorNodeUrlFor(options.network ?? "testnet");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 2_000;
  const minTransactions = options.minTransactions ?? 1;
  const sinceNanos = options.since ? toNanos(options.since) : undefined;

  // `order=desc` is not a preference, it is required for correctness.
  //
  // With `order=asc` and no `timestamp` lower bound the mirror node scans forward
  // from the beginning of the ledger and returns an empty page — for an account
  // that demonstrably has transactions. Verified against testnet: the same
  // account returns 0 results with `order=asc` and 3 with `order=desc`. A gate
  // written the obvious way therefore reports "no transactions" for a deploy that
  // worked, which is a false failure in the tier meant to prevent false passes.
  //
  // Newest-first is also what this gate wants: it asks what happened during this
  // run, and `timestamp=gte:` bounds that server-side when a window is known.
  const params = new URLSearchParams({
    "account.id": options.accountId,
    limit: "100",
    order: "desc",
  });
  if (options.since) params.set("timestamp", `gte:${options.since}`);
  const url = `${base}/api/v1/transactions?${params.toString()}`;

  const deadline = Date.now() + timeoutMs;
  let lastError: string | undefined;

  for (;;) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        lastError = `mirror node responded ${response.status}`;
      } else {
        const body = (await response.json()) as { transactions?: RawMirrorTransaction[] };
        const all = (body.transactions ?? []).map(normalize);
        const transactions =
          sinceNanos === undefined
            ? all
            : all.filter((t) => toNanos(t.consensusTimestamp) >= sinceNanos);
        if (transactions.length >= minTransactions || Date.now() >= deadline) {
          return { reachable: true, transactions };
        }
        lastError = undefined;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= deadline) {
      return lastError
        ? { reachable: false, transactions: [], error: lastError }
        : { reachable: true, transactions: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Verify that the deploy commands actually changed the chain.
 *
 * Produces findings in the harness's own vocabulary:
 * - `commands` — the chain disagrees with the exit code. That is an app defect.
 * - `semantic-infra` — the mirror node was unreachable. That is not.
 */
export async function verifyOnChainActivity(
  options: MirrorNodeGateOptions,
): Promise<MirrorNodeGateResult> {
  const { reachable, transactions, error } = await readSignerTransactions(options);
  const findings: ValidationFinding[] = [];

  if (!reachable) {
    findings.push({
      id: "chain-verify:mirror-node-unreachable",
      category: "semantic-infra",
      message: "Mirror node unreachable — on-chain verification was skipped",
      details:
        `${error ?? "unknown error"}\n` +
        `Tier 3.5 could not confirm what the deploy commands did. This is a harness ` +
        `infrastructure failure, not a defect in the generated app.`,
    });
    return { reachable: false, transactions: [], failures: [], entitiesCreated: [], findings };
  }

  const failures = transactions.filter((t) => !SUCCESS_RESULTS.has(t.result));
  const entitiesCreated = transactions
    .filter((t) => CREATE_TYPES.has(t.name) && SUCCESS_RESULTS.has(t.result) && t.entityId)
    .map((t) => t.entityId!);

  const minTransactions = options.minTransactions ?? 1;
  if (transactions.length < minTransactions) {
    findings.push({
      id: "chain-verify:no-transactions",
      category: "commands",
      message: `Chain deploy reported success but the test signer made no transactions`,
      details:
        `Expected at least ${minTransactions} transaction from ${options.accountId}; the mirror ` +
        `node has none for this run.\n` +
        `A Hedera deploy script can exit 0 without submitting anything — for example when the ` +
        `deploy is skipped by a guard, or when addresses are read from a stale artifacts file ` +
        `instead of being deployed. Exit code 0 is not evidence of a transaction.`,
    });
  }

  for (const failure of failures) {
    findings.push({
      id: `chain-verify:${failure.transactionId}`,
      category: "commands",
      message: `On-chain transaction failed at consensus: ${failure.result} (${failure.name})`,
      details:
        `transaction ${failure.transactionId} reached consensus at ` +
        `${failure.consensusTimestamp} with status ${failure.result}.\n` +
        `The deploy command exited 0, so this failure is invisible to the exit code. On Hedera, ` +
        `execute() only pre-checks; consensus failures surface via getReceipt(), which the ` +
        `deploy script likely does not call.`,
    });
  }

  return { reachable: true, transactions, failures, entitiesCreated, findings };
}

/** One line for the run log: what the chain says happened. */
export function summarizeChainActivity(result: MirrorNodeGateResult): string {
  if (!result.reachable) return "chain: mirror node unreachable, not verified";
  if (result.transactions.length === 0) return "chain: no transactions from the test signer";
  const parts = [`${result.transactions.length} tx`];
  if (result.failures.length > 0) parts.push(`${result.failures.length} failed at consensus`);
  if (result.entitiesCreated.length > 0) {
    parts.push(`created ${result.entitiesCreated.join(", ")}`);
  }
  const fees = result.transactions.reduce((sum, t) => sum + t.chargedFeeHbar, 0);
  parts.push(`${fees.toFixed(8)} ℏ in fees`);
  return `chain: ${parts.join(", ")}`;
}
