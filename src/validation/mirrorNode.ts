import type { ValidationFinding } from "../types.js";

/**
 * Tier 2.5 validator — Mirror Node REST queries against Hedera testnet.
 *
 * Fills the gap between Tier 2 (Playwright, browser only, no chain state)
 * and Tier 3.5 (chainSigner, real testnet HBAR spent). Reads-only, free,
 * no operator credentials required.
 *
 * Use cases
 *   - Assert a contract EVM address is deployed
 *   - Assert a token id exists and matches expected symbol/name
 *   - Assert an account has a recent successful contract call
 *   - Confirm HCS topic exists (for x402 / A2A audit trail flows)
 *
 * Cost: 0 HBAR. Every check is a REST GET against
 * https://{testnet,mainnet}.mirrornode.hedera.com/api/v1/*.
 *
 * The Mirror Node lags consensus by ~2–4 seconds (per Hedera docs). For
 * assertions that immediately follow a tx, consider a short retry loop.
 */

export type MirrorNodeNetwork = "testnet" | "mainnet";

const MIRROR_BASE: Record<MirrorNodeNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com/api/v1",
  mainnet: "https://mainnet-public.mirrornode.hedera.com/api/v1",
};

const DEFAULT_TIMEOUT_MS = 5000;

export interface MirrorNodeAssertion {
  /** Human-readable label for reporting. */
  name: string;
  /** Which mirror to query. Defaults to testnet. */
  network?: MirrorNodeNetwork;
  /** Assertion type. See below for shape per kind. */
  kind:
    | "contract-exists"
    | "token-exists"
    | "account-exists"
    | "topic-exists"
    | "recent-contract-call";
  /**
   * Target for the assertion:
   *   - contract-exists: EVM address (0x…) OR Hedera contract id (0.0.x)
   *   - token-exists:    Hedera token id (0.0.x) OR EVM address
   *   - account-exists:  Hedera account id (0.0.x) OR EVM address
   *   - topic-exists:    Hedera topic id (0.0.x)
   *   - recent-contract-call: EVM address or contract id of the callee
   */
  target: string;
  /** For token/account/topic — additional match constraints. */
  expected?: {
    symbol?: string;
    name?: string;
    memo?: string;
    /** For account-exists: minimum HBAR balance (in tinybars) the account must have. */
    minBalanceTinybars?: number;
  };
  /** For recent-contract-call: max age of the last call, in seconds. */
  maxAgeSeconds?: number;
}

export interface MirrorNodeValidationConfig {
  enabled: boolean;
  assertions: MirrorNodeAssertion[];
  /** Milliseconds per fetch. Applies per assertion. Defaults to 5s. */
  timeoutMs?: number;
  /** Retry each assertion N times on transient failure. Defaults to 1. */
  retries?: number;
}

/**
 * Run every assertion. Returns one finding per failure; empty list == pass.
 * Never throws — network errors are surfaced as findings, not exceptions,
 * so the outer validation stage can accumulate and report cleanly.
 */
export async function runMirrorNodeValidation(
  config: MirrorNodeValidationConfig,
): Promise<ValidationFinding[]> {
  if (!config.enabled || config.assertions.length === 0) return [];

  const findings: ValidationFinding[] = [];
  for (const a of config.assertions) {
    const finding = await runOne(a, config);
    if (finding) findings.push(finding);
  }
  return findings;
}

// ─── Assertion runners ────────────────────────────────────────────────────

async function runOne(
  a: MirrorNodeAssertion,
  config: MirrorNodeValidationConfig,
): Promise<ValidationFinding | null> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(1, config.retries ?? 1);
  const network: MirrorNodeNetwork = a.network ?? "testnet";
  let lastErr: string | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      switch (a.kind) {
        case "contract-exists":
          return await assertContractExists(network, a, timeoutMs);
        case "token-exists":
          return await assertTokenExists(network, a, timeoutMs);
        case "account-exists":
          return await assertAccountExists(network, a, timeoutMs);
        case "topic-exists":
          return await assertTopicExists(network, a, timeoutMs);
        case "recent-contract-call":
          return await assertRecentContractCall(network, a, timeoutMs);
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      // Exponential backoff between retries; capped short so a broken
      // mirror doesn't stall a whole validation stage.
      if (attempt < retries - 1) {
        await sleep(200 * Math.pow(2, attempt));
      }
    }
  }
  return {
    category: "mirror-node",
    id: `mirror-node-${a.kind}-transient`,
    message: `${a.name}: ${lastErr ?? "unknown error"}`,
  };
}

async function assertContractExists(
  network: MirrorNodeNetwork,
  a: MirrorNodeAssertion,
  timeoutMs: number,
): Promise<ValidationFinding | null> {
  const r = await mirrorGet<{ contract_id?: string; evm_address?: string; deleted?: boolean }>(
    network,
    `/contracts/${a.target}`,
    timeoutMs,
  );
  if (!r || r.deleted) {
    return {
      category: "mirror-node",
      id: "mirror-node-contract-missing",
      message: `${a.name}: contract ${a.target} not found on ${network}`,
    };
  }
  return null;
}

async function assertTokenExists(
  network: MirrorNodeNetwork,
  a: MirrorNodeAssertion,
  timeoutMs: number,
): Promise<ValidationFinding | null> {
  const r = await mirrorGet<{ token_id?: string; symbol?: string; name?: string; deleted?: boolean }>(
    network,
    `/tokens/${a.target}`,
    timeoutMs,
  );
  if (!r || r.deleted) {
    return {
      category: "mirror-node",
      id: "mirror-node-token-missing",
      message: `${a.name}: token ${a.target} not found on ${network}`,
    };
  }
  if (a.expected?.symbol && r.symbol !== a.expected.symbol) {
    return {
      category: "mirror-node",
      id: "mirror-node-token-symbol-mismatch",
      message: `${a.name}: token symbol mismatch — expected ${a.expected.symbol}, got ${r.symbol}`,
    };
  }
  if (a.expected?.name && r.name !== a.expected.name) {
    return {
      category: "mirror-node",
      id: "mirror-node-token-name-mismatch",
      message: `${a.name}: token name mismatch — expected "${a.expected.name}", got "${r.name}"`,
    };
  }
  return null;
}

async function assertAccountExists(
  network: MirrorNodeNetwork,
  a: MirrorNodeAssertion,
  timeoutMs: number,
): Promise<ValidationFinding | null> {
  const r = await mirrorGet<{ account?: string; balance?: { balance?: number }; deleted?: boolean }>(
    network,
    `/accounts/${a.target}`,
    timeoutMs,
  );
  if (!r || r.deleted) {
    return {
      category: "mirror-node",
      id: "mirror-node-account-missing",
      message: `${a.name}: account ${a.target} not found on ${network}`,
    };
  }
  const min = a.expected?.minBalanceTinybars;
  const balance = r.balance?.balance ?? 0;
  if (typeof min === "number" && balance < min) {
    return {
      category: "mirror-node",
      id: "mirror-node-account-underfunded",
      message: `${a.name}: account ${a.target} balance ${balance} < required ${min} tinybars`,
    };
  }
  return null;
}

async function assertTopicExists(
  network: MirrorNodeNetwork,
  a: MirrorNodeAssertion,
  timeoutMs: number,
): Promise<ValidationFinding | null> {
  const r = await mirrorGet<{ topic_id?: string; memo?: string; deleted?: boolean }>(
    network,
    `/topics/${a.target}`,
    timeoutMs,
  );
  if (!r || r.deleted) {
    return {
      category: "mirror-node",
      id: "mirror-node-topic-missing",
      message: `${a.name}: topic ${a.target} not found on ${network}`,
    };
  }
  if (a.expected?.memo && !(r.memo ?? "").includes(a.expected.memo)) {
    return {
      category: "mirror-node",
      id: "mirror-node-topic-memo-mismatch",
      message: `${a.name}: topic memo mismatch — expected substring "${a.expected.memo}", got "${r.memo ?? ""}"`,
    };
  }
  return null;
}

async function assertRecentContractCall(
  network: MirrorNodeNetwork,
  a: MirrorNodeAssertion,
  timeoutMs: number,
): Promise<ValidationFinding | null> {
  const maxAge = a.maxAgeSeconds ?? 3600; // default: last hour
  const r = await mirrorGet<{ results?: Array<{ timestamp: string; status?: string }> }>(
    network,
    `/contracts/${a.target}/results?limit=5&order=desc`,
    timeoutMs,
  );
  const latest = r?.results?.[0];
  if (!latest) {
    return {
      category: "mirror-node",
      id: "mirror-node-no-contract-calls",
      message: `${a.name}: contract ${a.target} has no calls indexed on ${network}`,
    };
  }
  // Mirror timestamps are "seconds.nanos" strings.
  const secs = parseInt(latest.timestamp.split(".")[0] ?? "0", 10);
  const ageSecs = Math.max(0, Date.now() / 1000 - secs);
  if (ageSecs > maxAge) {
    return {
      category: "mirror-node",
      id: "mirror-node-contract-call-stale",
      message: `${a.name}: latest call to ${a.target} was ${Math.floor(ageSecs)}s ago (max ${maxAge}s)`,
    };
  }
  if (latest.status && latest.status !== "SUCCESS") {
    return {
      category: "mirror-node",
      id: "mirror-node-contract-call-non-success",
      message: `${a.name}: latest call status ${latest.status}`,
    };
  }
  return null;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────

async function mirrorGet<T>(
  network: MirrorNodeNetwork,
  path: string,
  timeoutMs: number,
): Promise<T | null> {
  const url = `${MIRROR_BASE[network]}${path.startsWith("/") ? "" : "/"}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`mirror ${r.status} for ${path}`);
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
