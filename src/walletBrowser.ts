import { inspectWalletReady } from "./walletVault.js";
import { formatWalletBrowserLog, launchPreparedWalletBrowser } from "./walletMetaMask.js";

/**
 * Headed Chromium with MetaMask loaded via dappwright into a gitignored persistent profile.
 * Keys stay on disk; this process never prints them.
 */
export async function runWalletBrowser(workspaceDir: string): Promise<void> {
  const status = inspectWalletReady(workspaceDir);
  if (!status.ready) {
    throw new Error(`${status.reason}\n${status.provisionCommand}`);
  }

  const prepared = await launchPreparedWalletBrowser(workspaceDir);
  console.log(
    formatWalletBrowserLog({
      firstRun: prepared.firstRun,
      profile: prepared.profile,
      metamaskVersion: prepared.metamaskVersion,
    }),
  );

  await new Promise<void>(resolve => {
    const stop = () => {
      void prepared.context.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
