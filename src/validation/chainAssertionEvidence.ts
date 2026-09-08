/**
 * Independent chain evidence for deterministic on-chain postcondition assertions.
 *
 * Deliberately separate from any general "read mirror node reliably" utility that may land
 * upstream — this module answers exactly the two questions a chain assertion needs and nothing
 * more: "what was this transaction's real consensus result?" and "what is this account/token
 * balance right now?". It does not attempt to be a general-purpose Mirror Node client.
 *
 * Every query here distinguishes three outcomes, never conflating the last two:
 *   - a definite answer (the transaction/account was found, evidence returned)
 *   - "not found yet" after retrying through Mirror Node's normal propagation lag
 *   - a genuine infrastructure failure (network down, non-200 that isn't lag)
 * Callers must treat the second and third as "cannot evaluate this assertion right now",
 * never as evidence the underlying policy failed.
 */

const MIRROR_NODE_BASE_URL = "https://testnet.mirrornode.hedera.com/api/v1";

export interface EvidencePollOptions {
  /** Total time to keep retrying a 404 (propagation lag) before giving up. Default 20s. */
  maxWaitMs?: number;
  /** Delay between polls. Default 2s. */
  pollIntervalMs?: number;
  /** Override the base URL (tests only). */
  baseUrl?: string;
}

export type EvidenceResult<T> =
  | { status: "found"; value: T }
  | { status: "not-found" }
  | { status: "infra-error"; message: string };

/**
 * Converts an SDK-form transaction id ("0.0.1234@1699999999.123456789") to Mirror Node's
 * path form ("0.0.1234-1699999999-123456789"). Accepts either form already.
 */
export function toMirrorTransactionId(transactionId: string): string {
  const trimmed = transactionId.trim();
  if (trimmed.includes("@")) {
    const [accountId, timestamp] = trimmed.split("@");
    return `${accountId}-${timestamp.replace(".", "-")}`;
  }
  return trimmed;
}

/** First plausible Hedera transaction id ("0.0.x@seconds.nanos") found in free-form text. */
export function extractTransactionId(text: string): string | undefined {
  const match = text.match(/\b\d+\.\d+\.\d+@\d+\.\d+\b/);
  return match?.[0];
}

interface MirrorTransactionRecord {
  transaction_id: string;
  result: string;
  name: string;
  consensus_timestamp: string;
}

/**
 * The consensus result of a transaction ("SUCCESS", "CONTRACT_REVERT_EXECUTED",
 * "INVALID_SIGNATURE", etc.), as recorded by Mirror Node — never inferred from a script's exit
 * code. Retries through normal propagation lag; a transaction that never appears (network
 * issue, or the id was never actually submitted) is reported distinctly from a definite result.
 *
 * When a transaction id produced more than one record (e.g. a child transaction), the first
 * (the user transaction itself) is returned — a documented MVP limitation, not silent data loss.
 */
export async function fetchTransactionResult(
  transactionId: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<{ result: string; consensusTimestamp: string }>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/transactions/${toMirrorTransactionId(transactionId)}`;

  return pollForEvidence(path, response => {
    const body = response as { transactions?: MirrorTransactionRecord[] };
    const record = body.transactions?.[0];
    if (!record) return undefined;
    return { result: record.result, consensusTimestamp: record.consensus_timestamp };
  }, options);
}

interface MirrorAccountResponse {
  balance?: {
    balance: number;
    tokens?: Array<{ token_id: string; balance: number }>;
  };
}

/** Current HBAR balance of an account, in tinybars, as a bigint (exact, no float loss). */
export async function fetchHbarBalanceTinybars(
  accountId: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<bigint>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/accounts/${accountId}`;

  return pollForEvidence(
    path,
    response => {
      const body = response as MirrorAccountResponse;
      if (body.balance?.balance === undefined) return undefined;
      return BigInt(body.balance.balance);
    },
    options,
  );
}

/** Current balance of one HTS token for an account, in the token's smallest unit. */
export async function fetchTokenBalance(
  accountId: string,
  tokenId: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<bigint>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/accounts/${accountId}`;

  return pollForEvidence(
    path,
    response => {
      const body = response as MirrorAccountResponse;
      if (body.balance === undefined) return undefined;
      const entry = body.balance.tokens?.find(token => token.token_id === tokenId);
      // No association / zero balance both read as 0n — HTS has no other representation
      // of "never received any" vs "received then spent to exactly 0" via this endpoint.
      return BigInt(entry?.balance ?? 0);
    },
    options,
  );
}

/**
 * Shared GET-with-retry: 200 decodes via `extract`; `extract` returning undefined is treated
 * like a 404 (not found yet — the shape wasn't there); 404 retries until `maxWaitMs`; any other
 * non-200, a thrown fetch error, or exhausting the retry budget is an infra-error, never
 * silently treated as "not found" or as a policy result.
 */
async function pollForEvidence<T>(
  path: string,
  extract: (response: unknown) => T | undefined,
  options: EvidencePollOptions,
): Promise<EvidenceResult<T>> {
  const maxWaitMs = options.maxWaitMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + maxWaitMs;

  let lastNotFound = false;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(path);
    } catch (error) {
      return {
        status: "infra-error",
        message: `Mirror Node request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (response.status === 404) {
      lastNotFound = true;
    } else if (!response.ok) {
      return { status: "infra-error", message: `Mirror Node returned HTTP ${response.status} for ${path}` };
    } else {
      lastNotFound = false;
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        return {
          status: "infra-error",
          message: `Mirror Node returned invalid JSON for ${path}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const value = extract(body);
      if (value !== undefined) {
        return { status: "found", value };
      }
      // 200 but the shape we need isn't there yet (e.g. balance still settling) — retry same as 404.
    }

    if (Date.now() >= deadline) {
      return lastNotFound
        ? { status: "not-found" }
        : { status: "infra-error", message: `Mirror Node never returned the expected shape for ${path}` };
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
