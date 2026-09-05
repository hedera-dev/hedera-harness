import { importHieroSdk, type OptionalDepInstallOptions } from "../optionalDeps.js";
import type { PersistentWallet, WalletStatus } from "../types.js";
import { DEFAULT_HBAR_TARGET, DEFAULT_TESTNET_USDC_TOKEN_ID } from "./constants.js";
import { topUpWalletIfNeeded, type WalletFundingConfig } from "./funding.js";
import { assertTestnetOnly, loadWallet } from "./store.js";

export interface PreflightOptions extends WalletFundingConfig {
  requireUsdc?: boolean;
  usdcTokenId?: string;
  usdcMinimum?: number;
}

export interface PreflightResult {
  wallet: PersistentWallet;
  hbarBalance: number;
  usdcBalance?: number;
  toppedUpHbar?: number;
  ready: boolean;
  messages: string[];
}

export async function getWalletStatus(
  workspacePath: string,
  options: PreflightOptions = {},
  installOptions: OptionalDepInstallOptions = {},
): Promise<WalletStatus> {
  const wallet = await loadWallet(workspacePath);
  if (!wallet) {
    throw new Error(
      "No Harness Test Wallet found. Run `hedera-harness wallet init` first.",
    );
  }
  assertTestnetOnly(wallet.network);

  const sdk = await importHieroSdk(installOptions);
  const client = sdk.Client.forTestnet();
  try {
    const balance = await new sdk.AccountBalanceQuery()
      .setAccountId(sdk.AccountId.fromString(wallet.accountId))
      .execute(client);

    const hbarBalance = Number(balance.hbars.toTinybars().toString()) / 100_000_000;
    const tokenId = options.usdcTokenId ?? DEFAULT_TESTNET_USDC_TOKEN_ID;
    const tokenMap = balance.tokens;
    let usdcBalance: number | undefined;
    let associated = false;
    if (tokenMap) {
      const raw = tokenMap.get(sdk.TokenId.fromString(tokenId));
      if (raw !== undefined && raw !== null) {
        associated = true;
        usdcBalance = Number(raw.toString()) / 1_000_000;
      }
    }

    return { wallet, hbarBalance, usdcBalance, associated };
  } finally {
    client.close();
  }
}

export async function runWalletPreflight(
  workspacePath: string,
  options: PreflightOptions = {},
  installOptions: OptionalDepInstallOptions = {},
): Promise<PreflightResult> {
  const wallet = await loadWallet(workspacePath);
  if (!wallet) {
    throw new Error(
      "No Harness Test Wallet found. Run `hedera-harness wallet init` first.",
    );
  }

  const messages: string[] = [];
  const toppedUpHbar = await topUpWalletIfNeeded(wallet, options, installOptions);
  if (toppedUpHbar !== undefined) {
    messages.push(`Topped up +${toppedUpHbar} HBAR`);
  }

  const status = await getWalletStatus(workspacePath, options, installOptions);
  const target = options.hbarTarget ?? DEFAULT_HBAR_TARGET;
  let ready = status.hbarBalance >= target - 0.000_000_1;
  messages.push(
    `Account ${wallet.accountId}`,
    `HBAR ${status.hbarBalance.toFixed(4)} (target ${target})`,
  );

  if (options.requireUsdc) {
    const min = options.usdcMinimum ?? 1;
    const bal = status.usdcBalance ?? 0;
    messages.push(`USDC ${bal.toFixed(2)} (required ${min})`);
    if (!status.associated || bal < min) {
      ready = false;
      messages.push(
        `WALLET PREFLIGHT FAILED — fund USDC on ${wallet.accountId} (token ${options.usdcTokenId ?? DEFAULT_TESTNET_USDC_TOKEN_ID}) or use --asset hbar`,
      );
    }
  }

  if (ready) {
    messages.push("READY");
  }

  return {
    wallet,
    hbarBalance: status.hbarBalance,
    usdcBalance: status.usdcBalance,
    ...(toppedUpHbar !== undefined ? { toppedUpHbar } : {}),
    ready,
    messages,
  };
}

export function formatWalletStatus(status: WalletStatus): string {
  const lines = [
    "HARNESS TEST WALLET",
    "",
    "Network       Hedera Testnet",
    `Account       ${status.wallet.accountId}`,
    "",
    `HBAR          ${status.hbarBalance.toFixed(4)}`,
  ];
  if (status.usdcBalance !== undefined) {
    lines.push(`USDC          ${status.usdcBalance.toFixed(2)}`);
  } else {
    lines.push("USDC          (not associated — prefund or use --asset hbar)");
  }
  lines.push("", "Private key   ******** (stored under .harness/wallet/)");
  return lines.join("\n");
}
