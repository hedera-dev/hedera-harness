import { spawn } from "node:child_process";
import { inspectWalletReady, formatWalletStatus } from "./walletVault.js";
import { startWalletProvisionServer } from "./walletProvisionServer.js";

export async function runWalletStatus(workspaceDir: string): Promise<string> {
  return formatWalletStatus(inspectWalletReady(workspaceDir));
}

export async function runWalletProvision(
  workspaceDir: string,
  options: { open?: boolean; port?: number } = {},
): Promise<string> {
  const existing = inspectWalletReady(workspaceDir);
  if (existing.ready) {
    return formatWalletStatus(existing);
  }

  const server = await startWalletProvisionServer(workspaceDir, options.port ?? 0);
  const lines = [
    "Open this page on this machine and paste the TESTNET key there.",
    "Never paste a real/mainnet wallet. Never paste the key in OpenCode chat.",
    `url=${server.url}`,
    "Create a throwaway account: https://portal.hedera.com/",
  ];
  console.log(lines.join("\n"));
  if (options.open !== false) {
    openLocalUrl(server.url);
  }

  await server.saved;
  await server.close();
  return formatWalletStatus(inspectWalletReady(workspaceDir));
}

function openLocalUrl(url: string): void {
  const child =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : process.platform === "darwin"
        ? spawn("open", [url], { detached: true, stdio: "ignore" })
        : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}
