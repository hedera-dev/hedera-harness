import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { importHieroSdk, type OptionalDepInstallOptions } from "../optionalDeps.js";
import type { ChainSigner, ChainValidationConfig } from "../types.js";

type HieroSdk = typeof import("@hiero-ledger/sdk");
type PrivateKey = ReturnType<HieroSdk["PrivateKey"]["fromString"]>;

export const CHAIN_SIGNER_FILENAME = "chain-signer.json";

interface PersistedChainSigner extends ChainSigner {
  createdAt: string;
}

/**
 * Provision (or reuse) an ephemeral funded ECDSA testnet account for a run.
 * Persists to `runs/<id>/chain-signer.json` so continue/repair attempts share it.
 * When reusing, tops up HBAR if the balance is below `fundingHbar`.
 * If the persisted account was swept/deleted, provisions a fresh one.
 */
export async function provisionChainSigner(
  config: ChainValidationConfig,
  runDirectory: string,
  installOptions: OptionalDepInstallOptions = {},
): Promise<{ signer: ChainSigner; reused: boolean; toppedUpHbar?: number; replacedDeleted?: boolean }> {
  if (!config.enabled) {
    throw new Error("provisionChainSigner called with chainValidation.enabled=false");
  }

  if (config.network !== "testnet") {
    throw new Error(
      `chainValidation.network must be "testnet" (got ${JSON.stringify(config.network)}). Mainnet is not allowed.`,
    );
  }

  // Fail with a gate-specific install message before any network calls.
  await importHieroSdk(installOptions);

  const persistPath = chainSignerPath(runDirectory);
  const existing = await readPersistedSigner(persistPath);
  if (existing) {
    const signer = toPublicSigner(existing);
    const liveliness = await checkSignerLiveliness(signer, config);
    if (liveliness === "alive") {
      const toppedUpHbar = await topUpSignerIfNeeded(signer, config);
      return { signer, reused: true, ...(toppedUpHbar !== undefined ? { toppedUpHbar } : {}) };
    }

    // Account was swept at end of a prior cycle, or otherwise gone — replace it.
    await clearPersistedSigner(persistPath);
  }

  const created = await createFundedSigner(config, persistPath);
  return {
    signer: created,
    reused: false,
    ...(existing ? { replacedDeleted: true } : {}),
  };
}

async function createFundedSigner(
  config: ChainValidationConfig,
  persistPath: string,
): Promise<ChainSigner> {
  const sdk = await importHieroSdk();
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(config);
  const ephemeralKey = sdk.PrivateKey.generateECDSA();
  const evmAddress = ephemeralKey.publicKey.toEvmAddress();

  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  try {
    let receipt;
    try {
      receipt = await (
        await new sdk.AccountCreateTransaction()
          .setECDSAKeyWithAlias(ephemeralKey)
          // HIP-904 unlimited auto-association: templates that pay or reward
          // the signer in HTS tokens (USDC, badge tokens) would otherwise fail
          // with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT — a signer limitation the
          // repair loop would misread as an app defect.
          .setMaxAutomaticTokenAssociations(-1)
          .setInitialBalance(new sdk.Hbar(config.fundingHbar))
          .execute(client)
      ).getReceipt(client);
    } catch (error) {
      throw wrapProvisionError(error, operatorId, config);
    }

    const accountId = receipt.accountId?.toString();
    if (!accountId) {
      throw new Error("AccountCreateTransaction did not return an account ID.");
    }

    const signer: PersistedChainSigner = {
      accountId,
      privateKeyHex: normalizePrivateKeyHex(ephemeralKey.toStringRaw()),
      evmAddress: ensure0x(evmAddress),
      network: "testnet",
      createdAt: new Date().toISOString(),
    };

    // 0600: the file holds a live (funded) testnet private key.
    await writeFile(persistPath, `${JSON.stringify(signer, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return toPublicSigner(signer);
  } finally {
    client.close();
  }
}

/**
 * Returns whether the persisted signer account still exists on testnet.
 */
async function checkSignerLiveliness(
  signer: ChainSigner,
  config: ChainValidationConfig,
): Promise<"alive" | "deleted"> {
  const sdk = await importHieroSdk();
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(config);
  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  try {
    await new sdk.AccountBalanceQuery()
      .setAccountId(sdk.AccountId.fromString(signer.accountId))
      .execute(client);
    return "alive";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ACCOUNT_DELETED|INVALID_ACCOUNT_ID|ACCOUNT_ID_DOES_NOT_EXIST/i.test(message)) {
      return "deleted";
    }
    // Unexpected query failure — don't silently recreate; surface it.
    throw wrapProvisionError(error, operatorId, config);
  } finally {
    client.close();
  }
}

/**
 * Transfer enough HBAR from the operator so the signer balance reaches `fundingHbar`.
 * Returns the HBAR amount transferred, or undefined when no top-up was needed.
 */
async function topUpSignerIfNeeded(
  signer: ChainSigner,
  config: ChainValidationConfig,
): Promise<number | undefined> {
  const sdk = await importHieroSdk();
  const target = new sdk.Hbar(config.fundingHbar);
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(config);
  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  try {
    const balance = await new sdk.AccountBalanceQuery()
      .setAccountId(sdk.AccountId.fromString(signer.accountId))
      .execute(client);

    const currentTinybars = BigInt(balance.hbars.toTinybars().toString());
    const targetTinybars = BigInt(target.toTinybars().toString());
    if (currentTinybars >= targetTinybars) {
      return undefined;
    }

    const deltaTinybars = targetTinybars - currentTinybars;
    const delta = sdk.Hbar.fromTinybars(deltaTinybars.toString());
    try {
      await (
        await new sdk.TransferTransaction()
          .addHbarTransfer(sdk.AccountId.fromString(operatorId), delta.negated())
          .addHbarTransfer(sdk.AccountId.fromString(signer.accountId), delta)
          .execute(client)
      ).getReceipt(client);
    } catch (error) {
      throw wrapProvisionError(error, operatorId, config);
    }

    return Number(deltaTinybars) / 100_000_000;
  } finally {
    client.close();
  }
}

/**
 * Best-effort sweep: delete the ephemeral account and transfer remaining HBAR
 * back to the operator. Clears `chain-signer.json` on success so `--continue`
 * does not try to reuse a deleted account. An account still holding HTS tokens
 * cannot be deleted — its HBAR is drained instead and the account is kept for
 * reuse.
 */
export async function sweepChainSigner(
  signer: ChainSigner,
  config: ChainValidationConfig,
  runDirectory?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!config.sweepBack) {
    return { success: true };
  }

  try {
    const sdk = await importHieroSdk();
    const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(config);
    const ephemeralKey = sdk.PrivateKey.fromStringECDSA(strip0x(signer.privateKeyHex));

    // Operator pays fees; ephemeral key must sign the delete of its own account.
    const client = sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

    try {
      const frozen = await new sdk.AccountDeleteTransaction()
        .setAccountId(sdk.AccountId.fromString(signer.accountId))
        .setTransferAccountId(sdk.AccountId.fromString(operatorId))
        .freezeWith(client);
      const signed = await frozen.sign(ephemeralKey);
      try {
        await (await signed.execute(client)).getReceipt(client);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/TRANSACTION_REQUIRES_ZERO_TOKEN_BALANCES|ACCOUNT_IS_TREASURY/i.test(message)) {
          throw error;
        }
        // The signer auto-associated and still holds HTS tokens, so the
        // network refuses to delete the account. Recover the HBAR instead and
        // keep the account (and chain-signer.json): a later --continue can
        // reuse it together with its existing token associations.
        await drainHbarToOperator(sdk, client, signer, ephemeralKey, operatorId);
        return { success: true };
      }
      if (runDirectory) {
        await clearPersistedSigner(chainSignerPath(runDirectory));
      }
      return { success: true };
    } finally {
      client.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Move the signer's whole HBAR balance back to the operator. The operator is
 * the transaction payer, so the full balance can move — the signer pays no fee.
 */
async function drainHbarToOperator(
  sdk: HieroSdk,
  client: ReturnType<HieroSdk["Client"]["forTestnet"]>,
  signer: ChainSigner,
  ephemeralKey: PrivateKey,
  operatorId: string,
): Promise<void> {
  const balance = await new sdk.AccountBalanceQuery()
    .setAccountId(sdk.AccountId.fromString(signer.accountId))
    .execute(client);
  const tinybars = BigInt(balance.hbars.toTinybars().toString());
  if (tinybars === 0n) {
    return;
  }
  const amount = sdk.Hbar.fromTinybars(tinybars.toString());
  const frozen = await new sdk.TransferTransaction()
    .addHbarTransfer(sdk.AccountId.fromString(signer.accountId), amount.negated())
    .addHbarTransfer(sdk.AccountId.fromString(operatorId), amount)
    .freezeWith(client);
  const signed = await frozen.sign(ephemeralKey);
  await (await signed.execute(client)).getReceipt(client);
}

/**
 * Fail fast if operator env vars are missing (call before seeding / generator).
 * Does not load `@hiero-ledger/sdk` — key parse happens at provision time.
 */
export function assertChainValidationOperatorEnv(config: ChainValidationConfig): void {
  if (!config.enabled) return;
  // Throws with a clear message when env vars are absent or malformed.
  readOperatorEnv(config);
}

export function chainSignerPath(runDirectory: string): string {
  return path.join(runDirectory, CHAIN_SIGNER_FILENAME);
}

export function buildDeployEnv(
  signer: ChainSigner,
  exposeEnvVars: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {
    HARNESS_SIGNER_ACCOUNT_ID: signer.accountId,
    HARNESS_SIGNER_EVM_ADDRESS: signer.evmAddress,
    HARNESS_SIGNER_PRIVATE_KEY: signer.privateKeyHex,
  };
  for (const name of exposeEnvVars) {
    env[name] = signer.privateKeyHex;
  }
  return env;
}

const HEDERA_ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;

function readOperatorEnv(config: ChainValidationConfig): {
  accountId: string;
  privateKeyRaw: string;
} {
  const accountId = process.env[config.operator.accountIdEnv]?.trim();
  const privateKeyRaw = process.env[config.operator.privateKeyEnv]?.trim();

  if (!accountId) {
    throw new Error(
      `chainValidation requires env var ${config.operator.accountIdEnv} (Hedera testnet operator account ID, e.g. 0.0.xxxx).`,
    );
  }
  if (!HEDERA_ACCOUNT_ID_RE.test(accountId)) {
    const looksEvm = /^0x?[0-9a-fA-F]{40}$/.test(accountId);
    throw new Error(
      [
        `$${config.operator.accountIdEnv} must be a Hedera account ID like 0.0.xxxx (got ${JSON.stringify(accountId)}).`,
        looksEvm
          ? "That value looks like an EVM address — use the Account ID from the Hedera portal, not the EVM/alias address."
          : "Copy the Account ID field from https://portal.hedera.com (format 0.0.12345).",
      ].join(" "),
    );
  }
  if (!privateKeyRaw) {
    throw new Error(
      `chainValidation requires env var ${config.operator.privateKeyEnv} (ECDSA private key for the operator — hex or DER).`,
    );
  }

  return { accountId, privateKeyRaw };
}

async function readOperatorCredentials(config: ChainValidationConfig): Promise<{
  accountId: string;
  privateKey: PrivateKey;
}> {
  const { accountId, privateKeyRaw } = readOperatorEnv(config);
  const sdk = await importHieroSdk();
  return {
    accountId,
    privateKey: parseOperatorPrivateKey(sdk, privateKeyRaw, config.operator.privateKeyEnv),
  };
}

/**
 * Accept common portal/SDK export formats: raw ECDSA hex, DER hex, or auto-detect.
 * Tip: ECDSA secp256k1 private keys are 32 bytes (64 hex chars), optionally 0x-prefixed.
 */
function parseOperatorPrivateKey(sdk: HieroSdk, raw: string, envVarName: string): PrivateKey {
  const trimmed = raw.trim();
  const hex = strip0x(trimmed);
  const errors: string[] = [];

  // Prefer ECDSA (required for EVM alias / burner wallet).
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

  const byteHint =
    hex.length === 64
      ? ""
      : ` Your key hex length is ${hex.length} chars (${Math.floor(hex.length / 2)} bytes); a raw ECDSA private key is 64 hex chars (32 bytes).`;

  throw new Error(
    [
      `Could not parse $${envVarName} as a Hedera private key.${byteHint}`,
      "Use the ECDSA private key that owns the operator account (from portal.hedera.com).",
      "ED25519 operator keys are not supported — create/use an ECDSA account.",
      `Parse attempts: ${errors.join("; ")}`,
    ].join(" "),
  );
}

function wrapProvisionError(
  error: unknown,
  operatorId: string,
  config: ChainValidationConfig,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const isInvalidSignature = /INVALID_SIGNATURE/i.test(message);
  const isPayerNotFound = /PAYER_ACCOUNT_NOT_FOUND/i.test(message);
  const isInsufficient =
    /INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/i.test(message);

  if (isInvalidSignature) {
    return new Error(
      [
        `chainValidation: operator account ${operatorId} rejected with INVALID_SIGNATURE.`,
        `The private key in $${config.operator.privateKeyEnv} does not match that account (wrong key, wrong format, or ED25519 key for an ECDSA account).`,
        "Fix the host env vars and re-run. This is NOT an app defect — `run --continue` cannot repair it.",
        `SDK: ${message}`,
      ].join(" "),
    );
  }

  if (isPayerNotFound) {
    return new Error(
      [
        `chainValidation: payer account not found for ${operatorId}.`,
        "HEDERA_OPERATOR_ID must be an existing testnet account ID (0.0.xxxx), not an EVM address.",
        "Create/fund an ECDSA account at https://portal.hedera.com and use that Account ID + matching private key.",
        `SDK: ${message}`,
      ].join(" "),
    );
  }

  if (isInsufficient) {
    return new Error(
      [
        `chainValidation: operator account ${operatorId} has insufficient HBAR to fund the ephemeral signer.`,
        "Top up the testnet account from the Hedera portal faucet, then re-run.",
        `SDK: ${message}`,
      ].join(" "),
    );
  }

  return new Error(`chainValidation: failed to provision ephemeral signer: ${message}`);
}

async function readPersistedSigner(persistPath: string): Promise<PersistedChainSigner | undefined> {
  try {
    await access(persistPath);
    const raw = JSON.parse(await readFile(persistPath, "utf8")) as PersistedChainSigner;
    if (
      typeof raw.accountId === "string" &&
      typeof raw.privateKeyHex === "string" &&
      typeof raw.evmAddress === "string" &&
      raw.network === "testnet"
    ) {
      return raw;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function clearPersistedSigner(persistPath: string): Promise<void> {
  try {
    await unlink(persistPath);
  } catch {
    // Best-effort — missing file is fine.
  }
}

function toPublicSigner(persisted: PersistedChainSigner): ChainSigner {
  return {
    accountId: persisted.accountId,
    privateKeyHex: normalizePrivateKeyHex(persisted.privateKeyHex),
    evmAddress: ensure0x(persisted.evmAddress),
    network: "testnet",
  };
}

function normalizePrivateKeyHex(value: string): string {
  return ensure0x(strip0x(value));
}

function strip0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
}

function ensure0x(value: string): string {
  return value.startsWith("0x") || value.startsWith("0X") ? `0x${value.slice(2)}` : `0x${value}`;
}
