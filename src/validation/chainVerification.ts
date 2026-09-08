import type {
  ChainSigner,
  ChainTransactionProof,
  ChainValidationVerifyConfig,
  ChainVerificationResult,
  EvaluationResult,
  ValidationFinding,
} from "../types.js";

const DEFAULT_MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 5_000;

interface MirrorTransaction {
  transaction_id?: unknown;
  consensus_timestamp?: unknown;
  entity_id?: unknown;
}

interface VerifyOptions {
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  /** Test seam: stop after this many requests per transaction type. */
  maxPolls?: number;
}

interface TransactionTypeResult {
  proof?: ChainTransactionProof;
  finding?: ValidationFinding;
  infrastructureFailureReason?: string;
}

/**
 * Prove that the disposable signer paid for each required transaction type
 * after this attempt began. Filtering by signer and timestamp prevents a stale
 * testnet transaction from satisfying a new run.
 */
export async function verifyChainTransactions(
  signer: ChainSigner,
  config: ChainValidationVerifyConfig,
  since: Date,
  options: VerifyOptions = {},
): Promise<ChainVerificationResult> {
  const startedAt = Date.now();
  const transactionTypes = [...new Set(config.transactionTypes)];
  const results = await Promise.all(
    transactionTypes.map(transactionType =>
      verifyTransactionType(signer, config, transactionType, since, options),
    ),
  );

  const proofs = results.flatMap(result => (result.proof ? [result.proof] : []));
  const findings = results.flatMap(result => (result.finding ? [result.finding] : []));
  const infrastructureFailureReason = results.find(
    result => result.infrastructureFailureReason,
  )?.infrastructureFailureReason;

  return {
    passed: findings.length === 0,
    transactionTypes,
    proofs,
    findings,
    durationMs: Date.now() - startedAt,
    ...(infrastructureFailureReason
      ? {
          infrastructureFailure: true,
          infrastructureFailureReason,
        }
      : {}),
  };
}

export function attachChainVerification(
  evaluation: EvaluationResult,
  chainVerification: ChainVerificationResult,
): EvaluationResult {
  return {
    ...evaluation,
    passed: evaluation.passed && chainVerification.passed,
    findings: [...evaluation.findings, ...chainVerification.findings],
    chainVerification,
    durationMs: evaluation.durationMs + chainVerification.durationMs,
    ...(chainVerification.infrastructureFailure
      ? {
          infrastructureFailure: true,
          infrastructureFailureReason: chainVerification.infrastructureFailureReason,
        }
      : {}),
  };
}

async function verifyTransactionType(
  signer: ChainSigner,
  config: ChainValidationVerifyConfig,
  transactionType: string,
  since: Date,
  options: VerifyOptions,
): Promise<TransactionTypeResult> {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const url = buildTransactionsUrl(signer.accountId, transactionType, since);
  let polls = 0;
  let sawSuccessfulResponse = false;
  let lastInfrastructureError = "";
  let pollDelayMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  do {
    polls += 1;
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(timeoutMs, 10_000)),
      });
      if (!response.ok) {
        lastInfrastructureError = `Mirror Node returned HTTP ${response.status} for ${transactionType}.`;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          break;
        }
      } else {
        const payload = (await response.json()) as { transactions?: unknown };
        if (!Array.isArray(payload.transactions)) {
          lastInfrastructureError =
            `Mirror Node returned an invalid transactions payload for ${transactionType}.`;
          // Keep sawSuccessfulResponse false so a 200 with garbage stays infrastructure.
          break;
        }

        sawSuccessfulResponse = true;
        const transaction = payload.transactions.find(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const transactionId = (value as MirrorTransaction).transaction_id;
          const consensusTimestamp = (value as MirrorTransaction).consensus_timestamp;
          return (
            typeof transactionId === "string" &&
            transactionId.startsWith(`${signer.accountId}-`) &&
            typeof consensusTimestamp === "string"
          );
        }) as MirrorTransaction | undefined;
        if (transaction) {
          return {
            proof: {
              transactionType,
              transactionId: readString(transaction.transaction_id),
              consensusTimestamp: readString(transaction.consensus_timestamp),
              ...(typeof transaction.entity_id === "string"
                ? { entityId: transaction.entity_id }
                : {}),
            },
          };
        }
      }
    } catch (error) {
      lastInfrastructureError =
        error instanceof Error ? error.message : String(error);
    }

    if (options.maxPolls !== undefined && polls >= options.maxPolls) break;
    if (Date.now() >= deadline) break;
    await sleep(pollDelayMs);
    pollDelayMs = Math.min(pollDelayMs * 2, MAX_POLL_INTERVAL_MS);
  } while (Date.now() <= deadline);

  if (!sawSuccessfulResponse) {
    const reason =
      `Mirror Node unavailable while checking ${transactionType}: ` +
      (lastInfrastructureError || "no successful response");
    return {
      infrastructureFailureReason: reason,
      finding: {
        id: `chain-infra:${transactionType.toLowerCase()}`,
        category: "chain-infra",
        message: reason,
        details: url,
      },
    };
  }

  return {
    finding: {
      id: `chain-transaction:${transactionType.toLowerCase()}`,
      category: "chain",
      message:
        `No successful ${transactionType} transaction paid by test signer ` +
        `${signer.accountId} was indexed during this attempt.`,
      details: `Mirror query: ${url}`,
    },
  };
}

function buildTransactionsUrl(
  accountId: string,
  transactionType: string,
  since: Date,
): string {
  const url = new URL(`${DEFAULT_MIRROR_NODE_URL}/api/v1/transactions`);
  url.searchParams.set("account.id", accountId);
  url.searchParams.set("transactiontype", transactionType);
  url.searchParams.set("timestamp", `gte:${toConsensusTimestamp(since)}`);
  url.searchParams.set("result", "success");
  // account.id includes any account involved in a transaction, not only its
  // payer. Read a small window and bind proof to the payer prefix in transaction_id.
  url.searchParams.set("limit", "25");
  url.searchParams.set("order", "desc");
  return url.toString();
}

function toConsensusTimestamp(value: Date): string {
  const ms = value.getTime();
  const seconds = Math.floor(ms / 1_000);
  const nanos = (ms % 1_000) * 1_000_000;
  return `${seconds}.${String(nanos).padStart(9, "0")}`;
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
