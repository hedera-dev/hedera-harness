import { executeCommand } from "../command.js";
import { buildDeployEnv, redactSignerSecrets } from "./chainSigner.js";
import {
  extractEvmTransactionHash,
  extractTransactionId,
  fetchContractCallResult,
  fetchContractTokenBalance,
  fetchHbarBalanceTinybars,
  fetchTokenBalance,
  fetchTransactionResult,
  type EvidenceResult,
} from "./chainAssertionEvidence.js";
import type {
  ChainAssertionBalanceDeltaConfig,
  ChainAssertionConfig,
  ChainSigner,
  ChainValidationConfig,
  ValidationFinding,
} from "../types.js";

/** Injectable for tests — production code always uses the real Mirror Node reader. */
export interface ChainAssertionEvidenceDeps {
  fetchTransactionResult: typeof fetchTransactionResult;
  fetchContractCallResult: typeof fetchContractCallResult;
  fetchHbarBalanceTinybars: typeof fetchHbarBalanceTinybars;
  fetchTokenBalance: typeof fetchTokenBalance;
  fetchContractTokenBalance: typeof fetchContractTokenBalance;
}

const DEFAULT_DEPS: ChainAssertionEvidenceDeps = {
  fetchTransactionResult,
  fetchContractCallResult,
  fetchHbarBalanceTinybars,
  fetchTokenBalance,
  fetchContractTokenBalance,
};

export interface RunChainAssertionsInput {
  workspacePath: string;
  chainValidation: ChainValidationConfig;
  primarySigner: ChainSigner;
  /** Provisioned chainValidation.actors signers, keyed by name. */
  actorSigners: Record<string, ChainSigner>;
  deps?: Partial<ChainAssertionEvidenceDeps>;
}

/**
 * Executes every `chainValidation.assertions[]` entry and evaluates its outcome
 * deterministically — never by trusting the action command's own exit code, and never by an
 * LLM judgment. Each entry either passes silently or produces exactly one `ValidationFinding`:
 * `category: "chain-assertion"` for a confirmed policy violation (or a config problem the
 * repair loop can act on), `category: "chain-assertion-infra"` when the evidence needed to
 * decide either way could not be obtained (never treated as a pass or a violation).
 *
 * Known limitation, shared with the pre-existing `runChainDeploy`: `executeCommand` can reject
 * (not just resolve with a non-zero exit) on a child-process spawn error, which is not caught
 * here and would crash the run rather than yield a finding. Left as-is rather than mixing an
 * unrelated robustness fix (which would equally apply to `runChainDeploy`) into this change.
 */
export async function runChainAssertions(
  input: RunChainAssertionsInput,
): Promise<ValidationFinding[]> {
  const assertions = input.chainValidation.assertions ?? [];
  const deps: ChainAssertionEvidenceDeps = { ...DEFAULT_DEPS, ...input.deps };
  const findings: ValidationFinding[] = [];

  for (const assertion of assertions) {
    const finding = await runOneAssertion(assertion, input, deps);
    if (finding) findings.push(finding);
  }
  return findings;
}

type Asset = ChainAssertionBalanceDeltaConfig["asset"];

async function runOneAssertion(
  assertion: ChainAssertionConfig,
  input: RunChainAssertionsInput,
  deps: ChainAssertionEvidenceDeps,
): Promise<ValidationFinding | undefined> {
  const signer = assertion.actor ? input.actorSigners[assertion.actor] : input.primarySigner;
  if (!signer) {
    return violation(
      assertion,
      `references actor "${assertion.actor}", which was not provisioned for this run ` +
        "(expected it to be a key in chainValidation.actors).",
    );
  }

  const balanceDelta = assertion.expect.balanceDelta;
  let beforeBalance: bigint | undefined;
  let balanceAccountId: string | undefined;

  if (balanceDelta) {
    balanceAccountId = resolveBalanceAccountId(balanceDelta);
    if (!balanceAccountId) {
      return violation(
        assertion,
        `expect.balanceDelta.accountEnv "${balanceDelta.accountEnv}" is not set in the environment.`,
      );
    }
    const before = await sampleBalance(balanceAccountId, balanceDelta.asset, deps);
    if (before.status !== "found") {
      return infra(assertion, `sampling the BEFORE balance for ${balanceAccountId}`, before);
    }
    beforeBalance = before.value;
  }

  console.log(`[hedera-harness] Chain assertion: ${assertion.id} — ${assertion.action.name}`);

  const env = buildDeployEnv(signer, input.chainValidation.expose.envVars ?? []);
  const result = await executeCommand({
    command: assertion.action.command,
    cwd: input.workspacePath,
    env,
    timeoutMs: assertion.action.timeoutMs,
    shell: true,
  });

  // The action command itself failing to complete (non-zero exit, or timeout) is NOT evidence
  // of a policy violation — it could be a transient infra problem (RPC/relay unreachable) just
  // as easily as a script bug, and we cannot tell which from an exit code alone. Fail closed:
  // report "could not obtain evidence," never "the policy was violated," from an ambiguous
  // failure to execute. Only a script that exits 0 but never prints a transaction id is treated
  // as an actionable (non-infra) problem — that script ran to completion and simply isn't
  // wired correctly, which is something a repair attempt can fix.
  if (result.exitCode !== 0 || result.timedOut) {
    return {
      id: findingId(assertion),
      category: "chain-assertion-infra",
      message:
        `Assertion "${assertion.id}": action "${assertion.action.name}" did not complete ` +
        `(${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}) — could not obtain ` +
        "chain evidence for this attempt. This may be a transient infrastructure problem " +
        "(RPC/relay unreachable) rather than an application defect.",
      details: truncate(redactSecrets(result.stderr || result.stdout, input)),
    };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  // A native Hedera SDK transaction id ("0.0.x@sec.nanos") and an EVM transaction hash
  // ("0x" + 64 hex chars) never collide in shape, so trying both and taking whichever matches
  // is unambiguous — the action's signing stack (native @hiero-ledger/sdk vs. an EVM JSON-RPC
  // relay like Hashio/ethers/Hardhat) decides which one a script actually has to print.
  const transactionId = extractTransactionId(output);
  const evmTransactionHash = transactionId ? undefined : extractEvmTransactionHash(output);
  if (!transactionId && !evmTransactionHash) {
    return violation(
      assertion,
      `action "${assertion.action.name}" exited 0 but produced no parseable transaction id or ` +
        'hash in its output (expected either a native Hedera id, "0.0.x@seconds.nanos", or an ' +
        'EVM transaction hash, "0x" + 64 hex chars) — the action script must print the id/hash ' +
        "of the transaction it submitted.",
      truncate(redactSecrets(result.stderr || result.stdout, input)),
    );
  }

  const outcome = transactionId
    ? await deps.fetchTransactionResult(transactionId)
    : await deps.fetchContractCallResult(evmTransactionHash!);
  const evidenceId = transactionId ?? evmTransactionHash!;
  if (outcome.status !== "found") {
    return infra(assertion, `confirming transaction ${evidenceId}'s consensus result`, outcome, evidenceId);
  }

  const actualSucceeded = outcome.value.result === "SUCCESS";
  const expectSucceeded = assertion.expect.outcome === "mustSucceed";
  if (actualSucceeded !== expectSucceeded) {
    return {
      id: findingId(assertion),
      category: "chain-assertion",
      message:
        `Assertion "${assertion.id}" (${assertion.description ?? assertion.action.name}) FAILED: ` +
        `expected ${assertion.expect.outcome}, observed transaction result ${outcome.value.result}.`,
      evidence: { transactionId: evidenceId, expected: assertion.expect.outcome, observed: outcome.value.result },
    };
  }

  if (assertion.expect.reasonContains) {
    // Prefer the decoded human revert reason when the evidence has one (a standard
    // `Error(string)` revert on the EVM path) — the coarse `result` status
    // ("CONTRACT_REVERT_EXECUTED") is the same string for every revert reason, so checking
    // reasonContains against it alone can never actually distinguish *why* a call reverted.
    // Falls back to `result` for the native-transaction path and for custom-error reverts,
    // where no human-readable reason is available to decode — same behavior as before.
    const observedReason: string = outcome.value.revertReason ?? outcome.value.result;
    if (!observedReason.includes(assertion.expect.reasonContains)) {
      return {
        id: findingId(assertion),
        category: "chain-assertion",
        message:
          `Assertion "${assertion.id}" reverted as expected, but the observed reason ` +
          `"${observedReason}" did not contain "${assertion.expect.reasonContains}".`,
        evidence: {
          transactionId: evidenceId,
          expected: assertion.expect.reasonContains,
          observed: observedReason,
        },
      };
    }
  }

  if (balanceDelta && beforeBalance !== undefined && balanceAccountId) {
    const after = await sampleBalance(balanceAccountId, balanceDelta.asset, deps);
    if (after.status !== "found") {
      return infra(assertion, `sampling the AFTER balance for ${balanceAccountId}`, after, evidenceId);
    }
    const delta = after.value - beforeBalance;
    const expected = BigInt(balanceDelta.equals);
    if (delta !== expected) {
      return {
        id: findingId(assertion),
        category: "chain-assertion",
        message:
          `Assertion "${assertion.id}" balance delta mismatch for ${balanceAccountId}: ` +
          `expected ${expected}, observed ${delta}.`,
        evidence: { transactionId: evidenceId, expected: expected.toString(), observed: delta.toString() },
      };
    }
  }

  return undefined;
}

function resolveBalanceAccountId(
  balanceDelta: NonNullable<ChainAssertionConfig["expect"]["balanceDelta"]>,
): string | undefined {
  if (balanceDelta.account) return balanceDelta.account;
  if (balanceDelta.accountEnv) return process.env[balanceDelta.accountEnv]?.trim() || undefined;
  return undefined;
}

async function sampleBalance(
  accountId: string,
  asset: Asset,
  deps: ChainAssertionEvidenceDeps,
): Promise<EvidenceResult<bigint>> {
  if (asset === "hbar") {
    return deps.fetchHbarBalanceTinybars(accountId);
  }
  if ("tokenId" in asset) {
    return deps.fetchTokenBalance(accountId, asset.tokenId);
  }
  return deps.fetchContractTokenBalance(asset.contract, accountId);
}

function findingId(assertion: ChainAssertionConfig): string {
  return `chain-assertion:${assertion.id}`;
}

function violation(
  assertion: ChainAssertionConfig,
  message: string,
  details?: string,
): ValidationFinding {
  return {
    id: findingId(assertion),
    category: "chain-assertion",
    message: `Assertion "${assertion.id}" ${message}`,
    ...(details ? { details } : {}),
  };
}

function infra(
  assertion: ChainAssertionConfig,
  doing: string,
  evidence: EvidenceResult<unknown>,
  transactionId?: string,
): ValidationFinding {
  const reason =
    evidence.status === "not-found"
      ? "Mirror Node never returned it within the poll window (propagation lag, or it was never actually submitted)."
      : evidence.status === "infra-error"
        ? evidence.message
        : "unknown";
  return {
    id: findingId(assertion),
    category: "chain-assertion-infra",
    message: `Assertion "${assertion.id}": infrastructure failure while ${doing}. ${reason}`,
    ...(transactionId ? { evidence: { transactionId } } : {}),
  };
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function redactSecrets(text: string, input: RunChainAssertionsInput): string {
  return redactSignerSecrets(text, [input.primarySigner, ...Object.values(input.actorSigners)]);
}
