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

/** First plausible native Hedera transaction id ("0.0.x@seconds.nanos") found in free-form text. */
export function extractTransactionId(text: string): string | undefined {
  const match = text.match(/\b\d+\.\d+\.\d+@\d+\.\d+\b/);
  return match?.[0];
}

/**
 * First plausible EVM transaction hash ("0x" + 64 hex chars) found in free-form text — what an
 * ethers.js/JSON-RPC-relay action prints (e.g. `tx.hash`), as opposed to a native Hedera SDK
 * transaction id. Any Solidity contract call submitted through Hashio or another EVM relay
 * produces this form, not the native one — most Hedera dApps built with Hardhat/ethers/viem
 * fall into this category, not just ATS.
 */
export function extractEvmTransactionHash(text: string): string | undefined {
  const match = text.match(/\b0x[0-9a-fA-F]{64}\b/);
  return match?.[0];
}

interface MirrorTransactionRecord {
  transaction_id: string;
  result: string;
  name: string;
  consensus_timestamp: string;
}

/**
 * Shared shape for both transaction-result lookups, so a caller can treat either path
 * identically without narrowing a union. `errorMessage`/`revertReason` are always undefined
 * from `fetchTransactionResult` (the native path has no ABI-encoded revert data to decode) —
 * present here purely for type uniformity with `fetchContractCallResult`.
 */
export interface ChainTransactionEvidence {
  result: string;
  consensusTimestamp: string;
  errorMessage?: string;
  revertReason?: string;
}

/**
 * The consensus result of a native Hedera transaction ("SUCCESS", "INVALID_SIGNATURE", etc.),
 * as recorded by Mirror Node — never inferred from a script's exit code. Retries through normal
 * propagation lag; a transaction that never appears (network issue, or the id was never actually
 * submitted) is reported distinctly from a definite result.
 *
 * When a transaction id produced more than one record (e.g. a child transaction), the first
 * (the user transaction itself) is returned — a documented MVP limitation, not silent data loss.
 *
 * For a transaction submitted through an EVM JSON-RPC relay (ethers.js, Hardhat, viem — no
 * native transaction id available to the caller), use `fetchContractCallResult` instead.
 */
export async function fetchTransactionResult(
  transactionId: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<ChainTransactionEvidence>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/transactions/${toMirrorTransactionId(transactionId)}`;

  return pollForEvidence(path, response => {
    const body = response as { transactions?: MirrorTransactionRecord[] };
    const record = body.transactions?.[0];
    if (!record) return undefined;
    return { result: record.result, consensusTimestamp: record.consensus_timestamp };
  }, options);
}

interface MirrorContractResultRecord {
  result: string;
  status: string;
  error_message?: string | null;
  timestamp: string;
}

const ERROR_STRING_SELECTOR = "08c379a0";

/**
 * Decodes a standard Solidity `Error(string)` revert — what `require(condition, "message")`
 * produces — into its human-readable message. Returns undefined for anything else, including a
 * contract-specific custom error (a different 4-byte selector with arbitrary args): decoding
 * those needs the contract's own error ABI, which this module deliberately doesn't carry (see
 * the module comment) — a `reasonContains` check against a custom-error revert falls back to
 * matching the coarse `result` status instead, same as it always has.
 */
export function decodeStandardRevertReason(errorMessageHex: string): string | undefined {
  const hex = errorMessageHex.replace(/^0x/i, "");
  if (hex.length < 8 || hex.slice(0, 8).toLowerCase() !== ERROR_STRING_SELECTOR) return undefined;
  const data = hex.slice(8);
  if (data.length < 128) return undefined; // need at least the offset + length words
  const length = parseInt(data.slice(64, 128), 16);
  if (!Number.isFinite(length) || length < 0) return undefined;
  const stringHex = data.slice(128, 128 + length * 2);
  if (stringHex.length !== length * 2) return undefined;
  try {
    return Buffer.from(stringHex, "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * The consensus result of a transaction submitted through an EVM JSON-RPC relay, looked up by
 * its EVM transaction hash — same `result` vocabulary as `fetchTransactionResult`
 * ("SUCCESS"/"CONTRACT_REVERT_EXECUTED"/etc.), so callers compare it identically regardless of
 * which path found it. `error_message` is the raw ABI-encoded revert data when present;
 * `revertReason` is that data decoded into a human string when it's a standard `Error(string)`
 * revert (undefined for a custom error, where the raw selector+args can't be interpreted
 * without the contract's own ABI).
 */
export async function fetchContractCallResult(
  hash: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<ChainTransactionEvidence>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/contracts/results/${hash}`;

  return pollForEvidence(
    path,
    response => {
      const body = response as Partial<MirrorContractResultRecord>;
      if (!body.result) return undefined;
      const errorMessage =
        body.error_message && body.error_message !== "0x" ? body.error_message : undefined;
      const revertReason = errorMessage ? decodeStandardRevertReason(errorMessage) : undefined;
      return {
        result: body.result,
        consensusTimestamp: body.timestamp ?? "",
        ...(errorMessage ? { errorMessage } : {}),
        ...(revertReason !== undefined ? { revertReason } : {}),
      };
    },
    options,
  );
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

/**
 * Current balance of one HTS token for an account, in the token's smallest unit.
 *
 * A brand-new association (e.g. a token created and its treasury balance checked moments
 * later) can be absent from `/accounts/{id}`'s `balance.tokens[]` for a short window even
 * though the account endpoint itself already answers 200 — confirmed empirically: a fresh
 * `TokenCreateTransaction`'s treasury balance was visible in Mirror Node within ~3s, but
 * `extract` returning a defined `0n` for a merely-not-yet-indexed entry made the original
 * implementation treat that as a final answer on the very first poll, with zero retries.
 * `extract` here instead returns `undefined` (triggering the normal retry loop) while the
 * entry is absent, and `fallbackOnHealthyTimeout: 0n` supplies the real final answer — "never
 * received this token" and "received then spent to exactly 0" are still indistinguishable via
 * this endpoint (HTS has no other representation of that), but a real zero is no longer
 * confused with "hasn't propagated yet".
 */
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
      return entry === undefined ? undefined : BigInt(entry.balance);
    },
    options,
    undefined,
    0n,
  );
}

const ERC20_BALANCE_OF_SELECTOR = "70a08231";

/**
 * Current balance of one EVM/Solidity token contract for a holder, via its standard ERC20
 * `balanceOf(address)` view function — for a token that lives entirely as contract storage
 * (an ERC20/ERC1400-style token, which is what a Solidity security-token contract like an
 * Asset Tokenization Studio bond actually is), NOT a native HTS token. Confirmed empirically:
 * an ATS bond holder has no entry in Mirror Node's account/token-association data at all
 * (`fetchTokenBalance` would silently read 0 for every such holder, always) — `balanceOf` via
 * Mirror Node's read-only contract-call simulation (`/contracts/call`) is the only way to read
 * this kind of balance, and it needs no external JSON-RPC relay (Hashio or otherwise), keeping
 * this module's Mirror-Node-only dependency footprint.
 */
export async function fetchContractTokenBalance(
  contractAddress: string,
  holderAddress: string,
  options: EvidencePollOptions = {},
): Promise<EvidenceResult<bigint>> {
  const baseUrl = options.baseUrl ?? MIRROR_NODE_BASE_URL;
  const path = `${baseUrl}/contracts/call`;
  const paddedHolder = holderAddress.replace(/^0x/i, "").toLowerCase().padStart(64, "0");

  return pollForEvidence(
    path,
    response => {
      const body = response as { result?: string };
      if (!body.result) return undefined;
      return BigInt(body.result);
    },
    options,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: `0x${ERC20_BALANCE_OF_SELECTOR}${paddedHolder}`,
        to: contractAddress,
        estimate: false,
      }),
    },
  );
}

/**
 * Shared GET-with-retry: 200 decodes via `extract`; `extract` returning undefined is treated
 * like a 404 (not found yet — the shape wasn't there); 404 retries until `maxWaitMs`; any other
 * non-200, a thrown fetch error, or exhausting the retry budget is an infra-error, never
 * silently treated as "not found" or as a policy result.
 *
 * `fallbackOnHealthyTimeout`, when supplied, is the caller's real answer for "the endpoint
 * stayed healthy (every response was 200, `extract` just never found the expected shape) for
 * the entire retry budget" — e.g. a token balance that is legitimately zero (no association,
 * or spent down to it) looks identical, via `/accounts/{id}`, to one whose entry merely hasn't
 * been indexed yet. Without this, that case would misreport `infra-error` for a real, valid
 * answer. It is never used when a response was ever unhealthy (404/non-200/fetch failure) —
 * that keeps genuine infra trouble and network-down conditions reported as such.
 */
async function pollForEvidence<T>(
  path: string,
  extract: (response: unknown) => T | undefined,
  options: EvidencePollOptions,
  init?: RequestInit,
  fallbackOnHealthyTimeout?: T,
): Promise<EvidenceResult<T>> {
  const maxWaitMs = options.maxWaitMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + maxWaitMs;

  let lastNotFound = false;
  let lastErrorMessage: string | undefined;
  let everUnhealthy = false;
  for (;;) {
    let response: Response | undefined;
    try {
      response = await fetch(path, init);
    } catch (error) {
      // A single transient network blip (DNS hiccup, connection reset) is exactly the kind of
      // thing the retry loop already smooths over for a 404 -- giving up immediately here would
      // make the verdict depend on which poll happened to land on the blip, not on real chain
      // state. Retry it the same way, and only report infra-error if it never recovers.
      lastNotFound = false;
      everUnhealthy = true;
      lastErrorMessage = `Mirror Node request failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (response === undefined) {
      // handled below via lastErrorMessage
    } else if (response.status === 404) {
      lastNotFound = true;
      everUnhealthy = true;
      lastErrorMessage = undefined;
    } else if (!response.ok) {
      lastNotFound = false;
      everUnhealthy = true;
      lastErrorMessage = `Mirror Node returned HTTP ${response.status} for ${path}`;
    } else {
      lastNotFound = false;
      lastErrorMessage = undefined;
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
      if (!everUnhealthy && fallbackOnHealthyTimeout !== undefined) {
        return { status: "found", value: fallbackOnHealthyTimeout };
      }
      return lastNotFound
        ? { status: "not-found" }
        : {
            status: "infra-error",
            message: lastErrorMessage ?? `Mirror Node never returned the expected shape for ${path}`,
          };
    }
    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
