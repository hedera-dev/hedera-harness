import { importHieroSdk, type OptionalDepInstallOptions } from "../optionalDeps.js";
import type { PersistentWallet } from "../types.js";
import { assertTestnetOnly } from "./store.js";

export interface SignAndExecuteResult {
  transactionId: string;
  status: string;
}

/**
 * Sign and execute a Hedera TransactionList (base64 protobuf) with the
 * persistent wallet key. WalletKit must never own this path — Harness does.
 */
export async function signAndExecuteTransactionBytes(
  wallet: PersistentWallet,
  transactionListBase64: string,
  installOptions: OptionalDepInstallOptions = {},
): Promise<SignAndExecuteResult> {
  assertTestnetOnly(wallet.network);
  const sdk = await importHieroSdk(installOptions);
  const privateKey = sdk.PrivateKey.fromStringECDSA(strip0x(wallet.privateKeyHex));

  const bytes = Buffer.from(transactionListBase64, "base64");
  const transaction = sdk.Transaction.fromBytes(bytes);

  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(wallet.accountId), privateKey);

  try {
    const frozen =
      "isFrozen" in transaction && typeof transaction.isFrozen === "function" && transaction.isFrozen()
        ? transaction
        : await transaction.freezeWith(client);
    const signed = await frozen.sign(privateKey);
    const response = await signed.execute(client);
    const receipt = await response.getReceipt(client);
    return {
      transactionId: response.transactionId.toString(),
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}

/** Convenience HBAR transfer for smoke tests without WalletConnect. */
export async function transferHbar(
  wallet: PersistentWallet,
  toAccountId: string,
  amountHbar: number,
  installOptions: OptionalDepInstallOptions = {},
): Promise<SignAndExecuteResult> {
  assertTestnetOnly(wallet.network);
  if (amountHbar <= 0) {
    throw new Error("amountHbar must be positive");
  }

  const sdk = await importHieroSdk(installOptions);
  const privateKey = sdk.PrivateKey.fromStringECDSA(strip0x(wallet.privateKeyHex));
  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(wallet.accountId), privateKey);

  try {
    const amount = new sdk.Hbar(amountHbar);
    const response = await (
      await new sdk.TransferTransaction()
        .addHbarTransfer(sdk.AccountId.fromString(wallet.accountId), amount.negated())
        .addHbarTransfer(sdk.AccountId.fromString(toAccountId), amount)
        .execute(client)
    );
    const receipt = await response.getReceipt(client);
    return {
      transactionId: response.transactionId.toString(),
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}

/** Optional USDC (HTS) transfer when the wallet is already associated + funded. */
export async function transferHtsFungible(
  wallet: PersistentWallet,
  tokenId: string,
  toAccountId: string,
  amountWholeUnits: number,
  decimals = 6,
  installOptions: OptionalDepInstallOptions = {},
): Promise<SignAndExecuteResult> {
  assertTestnetOnly(wallet.network);
  const sdk = await importHieroSdk(installOptions);
  const privateKey = sdk.PrivateKey.fromStringECDSA(strip0x(wallet.privateKeyHex));
  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(wallet.accountId), privateKey);

  const base = 10n ** BigInt(decimals);
  const amount = BigInt(Math.trunc(amountWholeUnits)) * base;

  try {
    const response = await (
      await new sdk.TransferTransaction()
        .addTokenTransfer(sdk.TokenId.fromString(tokenId), sdk.AccountId.fromString(wallet.accountId), -amount)
        .addTokenTransfer(sdk.TokenId.fromString(tokenId), sdk.AccountId.fromString(toAccountId), amount)
        .execute(client)
    );
    const receipt = await response.getReceipt(client);
    return {
      transactionId: response.transactionId.toString(),
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}
