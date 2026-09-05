import { importHieroSdk, type OptionalDepInstallOptions } from "../optionalDeps.js";
import type { PersistentWallet } from "../types.js";
import {
  DEFAULT_HBAR_TARGET,
  DEFAULT_OPERATOR_ACCOUNT_ENV,
  DEFAULT_OPERATOR_KEY_ENV,
} from "./constants.js";
import { assertTestnetOnly, loadWallet, saveWallet, walletAccountPath } from "./store.js";

type HieroSdk = typeof import("@hiero-ledger/sdk");
type PrivateKey = ReturnType<HieroSdk["PrivateKey"]["fromString"]>;

export interface WalletFundingConfig {
  hbarTarget?: number;
  accountIdEnv?: string;
  privateKeyEnv?: string;
}

export interface InitWalletResult {
  wallet: PersistentWallet;
  created: boolean;
  toppedUpHbar?: number;
  persistPath: string;
}

/**
 * Create a persistent testnet wallet if missing, otherwise reuse it.
 * Unlike chainSigner, this account is never swept and lives under `.harness/wallet/`.
 */
export async function initPersistentWallet(
  workspacePath: string,
  config: WalletFundingConfig = {},
  installOptions: OptionalDepInstallOptions = {},
): Promise<InitWalletResult> {
  const existing = await loadWallet(workspacePath);
  if (existing) {
    assertTestnetOnly(existing.network);
    const toppedUpHbar = await topUpWalletIfNeeded(existing, config, installOptions);
    return {
      wallet: existing,
      created: false,
      ...(toppedUpHbar !== undefined ? { toppedUpHbar } : {}),
      persistPath: walletAccountPath(workspacePath),
    };
  }

  const created = await createFundedWallet(config, installOptions);
  const persistPath = await saveWallet(workspacePath, created);
  return { wallet: created, created: true, persistPath };
}

export async function topUpWalletIfNeeded(
  wallet: PersistentWallet,
  config: WalletFundingConfig = {},
  installOptions: OptionalDepInstallOptions = {},
): Promise<number | undefined> {
  assertTestnetOnly(wallet.network);
  const sdk = await importHieroSdk(installOptions);
  const targetHbar = config.hbarTarget ?? DEFAULT_HBAR_TARGET;
  const target = new sdk.Hbar(targetHbar);
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(
    config,
    sdk,
  );

  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  try {
    const balance = await new sdk.AccountBalanceQuery()
      .setAccountId(sdk.AccountId.fromString(wallet.accountId))
      .execute(client);

    const currentTinybars = BigInt(balance.hbars.toTinybars().toString());
    const targetTinybars = BigInt(target.toTinybars().toString());
    if (currentTinybars >= targetTinybars) {
      return undefined;
    }

    const deltaTinybars = targetTinybars - currentTinybars;
    const delta = sdk.Hbar.fromTinybars(deltaTinybars.toString());
    await (
      await new sdk.TransferTransaction()
        .addHbarTransfer(sdk.AccountId.fromString(operatorId), delta.negated())
        .addHbarTransfer(sdk.AccountId.fromString(wallet.accountId), delta)
        .execute(client)
    ).getReceipt(client);

    return Number(deltaTinybars) / 100_000_000;
  } finally {
    client.close();
  }
}

async function createFundedWallet(
  config: WalletFundingConfig,
  installOptions: OptionalDepInstallOptions,
): Promise<PersistentWallet> {
  const sdk = await importHieroSdk(installOptions);
  const fundingHbar = config.hbarTarget ?? DEFAULT_HBAR_TARGET;
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(
    config,
    sdk,
  );
  const ephemeralKey = sdk.PrivateKey.generateECDSA();

  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  try {
    const receipt = await (
      await new sdk.AccountCreateTransaction()
        .setECDSAKeyWithAlias(ephemeralKey)
        .setInitialBalance(new sdk.Hbar(fundingHbar))
        .execute(client)
    ).getReceipt(client);

    const accountId = receipt.accountId?.toString();
    if (!accountId) {
      throw new Error("AccountCreateTransaction did not return an account ID.");
    }

    return {
      accountId,
      privateKeyHex: normalizePrivateKeyHex(ephemeralKey.toStringRaw()),
      publicKeyHex: ephemeralKey.publicKey.toStringRaw(),
      network: "testnet",
      createdAt: new Date().toISOString(),
    };
  } finally {
    client.close();
  }
}

export async function readOperatorCredentials(
  config: WalletFundingConfig,
  sdk?: HieroSdk,
): Promise<{ accountId: string; privateKey: PrivateKey }> {
  const resolvedSdk = sdk ?? (await importHieroSdk());
  const accountIdEnv = config.accountIdEnv ?? DEFAULT_OPERATOR_ACCOUNT_ENV;
  const privateKeyEnv = config.privateKeyEnv ?? DEFAULT_OPERATOR_KEY_ENV;
  const accountId = process.env[accountIdEnv]?.trim();
  const privateKeyRaw = process.env[privateKeyEnv]?.trim();

  if (!accountId) {
    throw new Error(
      `Harness Test Wallet requires env var ${accountIdEnv} (Hedera testnet operator account ID, e.g. 0.0.xxxx).`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(accountId)) {
    throw new Error(
      `$${accountIdEnv} must be a Hedera account ID like 0.0.xxxx (got ${JSON.stringify(accountId)}).`,
    );
  }
  if (!privateKeyRaw) {
    throw new Error(
      `Harness Test Wallet requires env var ${privateKeyEnv} (ECDSA private key for the operator).`,
    );
  }

  return {
    accountId,
    privateKey: parseOperatorPrivateKey(resolvedSdk, privateKeyRaw, privateKeyEnv),
  };
}

function parseOperatorPrivateKey(sdk: HieroSdk, raw: string, envVarName: string): PrivateKey {
  const trimmed = raw.trim();
  const hex = strip0x(trimmed);
  const errors: string[] = [];

  try {
    return sdk.PrivateKey.fromStringECDSA(hex);
  } catch (error) {
    errors.push(`ECDSA: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return sdk.PrivateKey.fromStringDer(hex);
  } catch (error) {
    errors.push(`DER: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return sdk.PrivateKey.fromString(trimmed);
  } catch (error) {
    errors.push(`auto: ${error instanceof Error ? error.message : String(error)}`);
  }

  throw new Error(
    [
      `Could not parse $${envVarName} as a Hedera private key.`,
      "Use the ECDSA private key that owns the operator account (from portal.hedera.com).",
      `Parse attempts: ${errors.join("; ")}`,
    ].join(" "),
  );
}

function normalizePrivateKeyHex(value: string): string {
  return `0x${strip0x(value)}`;
}

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}
