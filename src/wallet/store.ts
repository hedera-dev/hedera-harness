import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistentWallet } from "../types.js";
import { WALLET_ACCOUNT_FILENAME, WALLET_DIRNAME } from "./constants.js";

export function walletDir(workspacePath: string): string {
  return path.join(workspacePath, ".harness", WALLET_DIRNAME);
}

export function walletAccountPath(workspacePath: string): string {
  return path.join(walletDir(workspacePath), WALLET_ACCOUNT_FILENAME);
}

/**
 * Load the persistent test wallet, or undefined when not initialized.
 * Never logs or returns secrets to callers beyond the typed object —
 * CLI status formatting must redact privateKeyHex.
 */
export async function loadWallet(workspacePath: string): Promise<PersistentWallet | undefined> {
  const persistPath = walletAccountPath(workspacePath);
  try {
    await access(persistPath);
  } catch {
    return undefined;
  }

  const raw = JSON.parse(await readFile(persistPath, "utf8")) as Partial<PersistentWallet>;
  if (
    typeof raw.accountId !== "string" ||
    typeof raw.privateKeyHex !== "string" ||
    typeof raw.publicKeyHex !== "string" ||
    raw.network !== "testnet" ||
    typeof raw.createdAt !== "string"
  ) {
    throw new Error(
      `Corrupt Harness Test Wallet at ${persistPath}. Delete it and re-run \`hedera-harness wallet init\`.`,
    );
  }

  return {
    accountId: raw.accountId,
    privateKeyHex: normalizePrivateKeyHex(raw.privateKeyHex),
    publicKeyHex: raw.publicKeyHex,
    network: "testnet",
    createdAt: raw.createdAt,
  };
}

export async function saveWallet(
  workspacePath: string,
  wallet: PersistentWallet,
): Promise<string> {
  assertTestnetOnly(wallet.network);
  const dir = walletDir(workspacePath);
  await mkdir(dir, { recursive: true });
  const persistPath = walletAccountPath(workspacePath);
  // 0600: live testnet private key. Windows ignores mode but we still set it.
  await writeFile(persistPath, `${JSON.stringify(wallet, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return persistPath;
}

export function assertTestnetOnly(network: string): void {
  if (network !== "testnet") {
    throw new Error(
      `Harness Test Wallet only supports Hedera testnet (got ${JSON.stringify(network)}). Mainnet is not allowed.`,
    );
  }
}

export function redactWallet(wallet: PersistentWallet): Omit<PersistentWallet, "privateKeyHex"> & {
  privateKeyHex: string;
} {
  return {
    ...wallet,
    privateKeyHex: "********",
  };
}

function normalizePrivateKeyHex(value: string): string {
  const stripped = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return `0x${stripped}`;
}
