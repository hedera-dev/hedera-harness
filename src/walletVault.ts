import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const WALLET_DIR = ".harness/wallet";
export const VAULT_FILE = "metamask-test.json";
export const PROFILE_DIR = "chrome-profile";
export const IMPORTED_MARKER = "metamask-imported.json";

export interface MetamaskTestVault {
  schemaVersion: 1;
  kind: "metamask-testnet";
  createdAt: string;
  /** MetaMask extension password (local Chromium profile). */
  password: string;
  /** ECDSA hex private key from portal.hedera.com — TESTNET ONLY. */
  privateKey: string;
}

export interface WalletReadyStatus {
  ready: boolean;
  workspace: string;
  kind?: "metamask-testnet";
  profilePresent: boolean;
  metamaskImported: boolean;
  reason: string;
  provisionCommand: string;
}

export function walletDir(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), WALLET_DIR);
}

export function vaultPath(workspaceDir: string): string {
  return path.join(walletDir(workspaceDir), VAULT_FILE);
}

export function chromeProfilePath(workspaceDir: string): string {
  return path.join(walletDir(workspaceDir), PROFILE_DIR);
}

export function isVaultReady(vault: unknown): vault is MetamaskTestVault {
  if (!vault || typeof vault !== "object") return false;
  const record = vault as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    record.kind === "metamask-testnet" &&
    typeof record.password === "string" &&
    record.password.length >= 8 &&
    typeof record.privateKey === "string" &&
    isHexPrivateKey(record.privateKey)
  );
}

export function isHexPrivateKey(value: string): boolean {
  const hex = value.trim().replace(/^0x/i, "");
  return /^[0-9a-fA-F]{64}$/.test(hex);
}

export function normalizePrivateKey(value: string): string {
  const hex = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Private key must be 64 hex characters (Hedera portal ECDSA, testnet only).");
  }
  return `0x${hex}`;
}

export function readVaultFile(workspaceDir: string): MetamaskTestVault | undefined {
  const file = vaultPath(workspaceDir);
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isVaultReady(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeVaultFile(
  workspaceDir: string,
  input: { password: string; privateKey: string },
): string {
  const password = input.password.trim();
  if (password.length < 8) {
    throw new Error("MetaMask password must be at least 8 characters.");
  }
  const privateKey = normalizePrivateKey(input.privateKey);
  const dir = walletDir(workspaceDir);
  mkdirSync(dir, { recursive: true });
  const vault: MetamaskTestVault = {
    schemaVersion: 1,
    kind: "metamask-testnet",
    createdAt: new Date().toISOString(),
    password,
    privateKey,
  };
  const file = vaultPath(workspaceDir);
  writeFileSync(file, `${JSON.stringify(vault, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  ensureWalletGitignore(workspaceDir);
  return file;
}

export function metamaskImportedMarkerPath(workspaceDir: string): string {
  return path.join(walletDir(workspaceDir), IMPORTED_MARKER);
}

export function isMetaMaskImported(workspaceDir: string): boolean {
  return existsSync(metamaskImportedMarkerPath(workspaceDir));
}

/** No secrets — only that dappwright finished import + Hedera Testnet. */
export function writeMetaMaskImportedMarker(workspaceDir: string): void {
  const dir = walletDir(workspaceDir);
  mkdirSync(dir, { recursive: true });
  const body = {
    schemaVersion: 1,
    kind: "metamask-imported",
    network: "Hedera Testnet",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(metamaskImportedMarkerPath(workspaceDir), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export function inspectWalletReady(workspaceDir: string): WalletReadyStatus {
  const workspace = path.resolve(workspaceDir);
  const provisionCommand = `hedera-harness wallet provision --workspace ${workspace}`;
  const vault = readVaultFile(workspace);
  const profilePresent = existsSync(chromeProfilePath(workspace));
  const metamaskImported = isMetaMaskImported(workspace);
  if (!vault) {
    return {
      ready: false,
      workspace,
      profilePresent,
      metamaskImported,
      reason: "No MetaMask test vault. Open the local provision page — never paste a key in chat.",
      provisionCommand,
    };
  }
  return {
    ready: true,
    workspace,
    kind: "metamask-testnet",
    profilePresent,
    metamaskImported,
    reason: "Test vault present. Agent must not read .harness/wallet/.",
    provisionCommand,
  };
}

export function formatWalletStatus(status: WalletReadyStatus): string {
  return [
    `ready=${status.ready}`,
    `workspace=${status.workspace}`,
    status.kind ? `kind=${status.kind}` : undefined,
    `profile=${status.profilePresent ? "present" : "missing"}`,
    `metamask=${status.metamaskImported ? "imported" : "pending"}`,
    `reason=${status.reason}`,
    `provision=${status.provisionCommand}`,
    "never_ask_in_chat=true",
    "testnet_only=true",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function ensureWalletGitignore(workspaceDir: string): void {
  const gitignorePath = path.join(path.resolve(workspaceDir), ".gitignore");
  const line = ".harness/wallet/";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${line}\n`, "utf8");
    return;
  }
  const existing = readFileSync(gitignorePath, "utf8");
  if (existing.includes(line)) return;
  const separator = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${existing}${separator}${line}\n`, "utf8");
}
