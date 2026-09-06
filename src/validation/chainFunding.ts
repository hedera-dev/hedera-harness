import { importHieroSdk } from "../optionalDeps.js";
import type { ChainValidationConfig } from "../types.js";

/**
 * Whether the operator account can pay for the runs it is about to authorise.
 *
 * Tier 3.5 provisions an ephemeral account and funds it with `fundingHbar` from the operator.
 * That transfer happens inside `run`, after baseline installs and builds are already paid for, so
 * an underfunded operator is discovered at the worst moment. This is the cheap check for it.
 */

/** Headroom for the transfer and account-creation fees on top of the funded amount. */
export const FEE_MARGIN_HBAR = 1;
/** Below this many runs' worth of HBAR the operator is reported as low rather than fine. */
export const COMFORTABLE_RUNS = 3;

export type FundingVerdict = "ok" | "low" | "insufficient";

export interface FundingAssessment {
  verdict: FundingVerdict;
  /** Whole runs the balance can fund, fees included. */
  runsAffordable: number;
  detail: string;
  fix?: string;
}

/**
 * Pure half of the check: given a balance and what one run draws, say whether the run can start.
 * Kept separate from the network call so the thresholds are testable without a node.
 */
export function assessOperatorFunding(
  balanceHbar: number,
  config: Pick<ChainValidationConfig, "fundingHbar" | "deploy">,
): FundingAssessment {
  const perRun = config.fundingHbar + FEE_MARGIN_HBAR;
  const runsAffordable = Math.max(0, Math.floor(balanceHbar / perRun));
  const balance = `${round(balanceHbar)} HBAR`;
  const draw = `${config.fundingHbar} HBAR per run + fees`;

  if (runsAffordable < 1) {
    return {
      verdict: "insufficient",
      runsAffordable,
      detail: `operator holds ${balance}, a run draws ${draw}`,
      fix: [
        `Top up the operator at https://portal.hedera.com/faucet, or lower chainValidation.fundingHbar.`,
        `Provisioning happens after baseline installs and builds, so this fails a run that has already spent minutes.`,
      ].join("\n"),
    };
  }

  if (runsAffordable < COMFORTABLE_RUNS) {
    return {
      verdict: "low",
      runsAffordable,
      detail: `operator holds ${balance} — ${runsAffordable} run${runsAffordable === 1 ? "" : "s"} at ${draw}`,
      fix: `A repair cycle can run several attempts. Top up before a long run: https://portal.hedera.com/faucet`,
    };
  }

  const deployNote = config.deploy
    ? " — the recipe deploys contracts, so fundingHbar must also cover the relay reserving gasLimit × gasPrice up front, not just the fee finally charged"
    : "";
  return {
    verdict: "ok",
    runsAffordable,
    detail: `operator holds ${balance} — ${runsAffordable} runs at ${draw}${deployNote}`,
  };
}

/** Reads the operator's HBAR balance. Throws with the operator id when the query fails. */
export async function readOperatorBalanceHbar(config: ChainValidationConfig): Promise<number> {
  const accountId = process.env[config.operator.accountIdEnv];
  const privateKey = process.env[config.operator.privateKeyEnv];
  if (!accountId || !privateKey) {
    throw new Error(
      `${config.operator.accountIdEnv} and ${config.operator.privateKeyEnv} must be set to read the operator balance.`,
    );
  }

  const sdk = await importHieroSdk();
  const client = sdk.Client.forName(config.network);
  client.setOperator(sdk.AccountId.fromString(accountId), sdk.PrivateKey.fromStringECDSA(strip0x(privateKey)));
  try {
    const balance = await new sdk.AccountBalanceQuery()
      .setAccountId(sdk.AccountId.fromString(accountId))
      .execute(client);
    return Number(BigInt(balance.hbars.toTinybars().toString())) / 100_000_000;
  } catch (error) {
    const underlying = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the balance of operator ${accountId}: ${underlying}`);
  } finally {
    client.close();
  }
}

function strip0x(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function round(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(2);
}
