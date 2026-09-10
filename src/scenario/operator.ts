import { importHieroSdk } from "../optionalDeps.js";
import type { ChainValidationOperatorConfig, TemplateSpec } from "../types.js";

type HieroSdk = typeof import("@hiero-ledger/sdk");
type PrivateKey = ReturnType<HieroSdk["PrivateKey"]["fromString"]>;

const HEDERA_ACCOUNT_ID_RE = /^\d+\.\d+\.\d+$/;

export function resolveScenarioOperator(spec: TemplateSpec): ChainValidationOperatorConfig {
  if (spec.scenarios?.operator) return spec.scenarios.operator;
  if (spec.chainValidation?.operator) return spec.chainValidation.operator;
  throw new Error(
    "scenarios requires operator env names, or reuse them from chainValidation.operator.",
  );
}

export function assertScenarioOperatorEnv(spec: TemplateSpec): void {
  readOperatorEnv(resolveScenarioOperator(spec));
}

export function readOperatorEnv(operator: ChainValidationOperatorConfig): {
  accountId: string;
  privateKeyRaw: string;
} {
  const accountId = process.env[operator.accountIdEnv]?.trim();
  const privateKeyRaw = process.env[operator.privateKeyEnv]?.trim();
  if (!accountId) {
    throw new Error(
      `scenarios requires env var ${operator.accountIdEnv} (Hedera testnet operator account ID).`,
    );
  }
  if (!HEDERA_ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(
      `$${operator.accountIdEnv} must be a Hedera account ID like 0.0.xxxx (got ${JSON.stringify(accountId)}).`,
    );
  }
  if (!privateKeyRaw) {
    throw new Error(
      `scenarios requires env var ${operator.privateKeyEnv} (ECDSA private key for the operator).`,
    );
  }
  return { accountId, privateKeyRaw };
}

export async function readOperatorCredentials(operator: ChainValidationOperatorConfig): Promise<{
  accountId: string;
  privateKey: PrivateKey;
}> {
  const { accountId, privateKeyRaw } = readOperatorEnv(operator);
  const sdk = await importHieroSdk();
  return {
    accountId,
    privateKey: parseOperatorPrivateKey(sdk, privateKeyRaw, operator.privateKeyEnv),
  };
}

export function parseOperatorPrivateKey(
  sdk: HieroSdk,
  raw: string,
  envVarName: string,
): PrivateKey {
  const trimmed = raw.trim();
  const hex = trimmed.replace(/^0x/i, "");
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
  throw new Error(`Could not parse $${envVarName} as an ECDSA operator key. ${errors.join(" | ")}`);
}
