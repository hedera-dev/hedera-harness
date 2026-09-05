import path from "node:path";
import type { WalletCliOptions } from "../types.js";
import { runWalletDemo } from "./demo.js";
import { initPersistentWallet } from "./funding.js";
import { formatWalletStatus, getWalletStatus, runWalletPreflight } from "./preflight.js";

export async function runWalletCommand(options: WalletCliOptions): Promise<void> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());

  if (options.subcommand === "init") {
    const result = await initPersistentWallet(workspacePath, {
      hbarTarget: options.hbarTarget,
    });
    console.log(
      [
        result.created ? "Creating Harness Test Wallet..." : "Reusing Harness Test Wallet...",
        "",
        "Network       testnet",
        `Account       ${result.wallet.accountId}`,
        options.hbarTarget ? `Target HBAR   ${options.hbarTarget}` : undefined,
        result.toppedUpHbar !== undefined ? `Top-up        +${result.toppedUpHbar}` : undefined,
        "",
        result.created ? "✓ wallet created" : "✓ wallet loaded",
        "✓ credentials secured under .harness/wallet/",
        "✓ private key never exported to the coding agent",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    );
    return;
  }

  if (options.subcommand === "status") {
    await runWalletPreflight(workspacePath, { hbarTarget: options.hbarTarget });
    const status = await getWalletStatus(workspacePath);
    console.log(formatWalletStatus(status));
    return;
  }

  if (options.subcommand === "demo") {
    console.log("WALLET DEMO\n");
    const result = await runWalletDemo(workspacePath, options);
    console.log(
      [
        "PREFLIGHT                 ✓",
        `wallet                    ${result.accountId}`,
        "browser + extension       ✓",
        "",
        "EVALUATE (wallet boundary)",
        "  Connect → Approve       ✓",
        "  Pay → Sign              ✓",
        `  Payment successful      ✓`,
        "",
        "CHAIN",
        `  Transaction             ${result.transactionId}`,
        `  Mirror                  ${result.mirrored ? "✓" : "pending/unavailable"}`,
        "",
        "PASSED",
      ].join("\n"),
    );
    return;
  }

  throw new Error(`Unknown wallet subcommand`);
}

export function printWalletHelp(): void {
  console.log(`hedera-harness wallet

Usage:
  hedera-harness wallet init [--workspace <path>] [--hbar-target <n>]
  hedera-harness wallet status [--workspace <path>] [--hbar-target <n>]
  hedera-harness wallet demo [--workspace <path>] [--asset hbar|usdc] [--amount <n>] [--pay-to <0.0.x>] [--headed|--headless]

The Harness Test Wallet is a persistent testnet identity for validating the
wallet boundary (connect → approve → sign) between browser EVALUATE and CHAIN.

Private keys live in .harness/wallet/account.json (gitignored) and are never
injected into the coding agent or application env.`);
}
