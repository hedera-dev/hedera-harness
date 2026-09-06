import type { DoctorCheck } from "./doctor.js";

/**
 * Preflight the Hedera operator credentials, not just their presence.
 *
 * `doctor` already reports whether the operator env vars are set. Set is not the same as usable,
 * and every failure below passes a presence check and then costs a full run:
 *
 *   - an EVM address pasted into the account id variable (both are "the address" in conversation)
 *   - an ED25519 key against an ECDSA account, or the reverse, which surfaces much later as an
 *     INVALID_SIGNATURE with nothing pointing at the key format
 *   - an account that exists on mainnet but not on the network the recipe declares
 *   - a balance too small to fund the ephemeral signer the run is about to provision
 *
 * A run costs forty minutes to two hours. Learning that the operator key is the wrong curve
 * should take two seconds, which is the same argument `doctor` already makes for the agent CLI.
 *
 * No new dependencies: key type comes from the DER prefix, everything else from the mirror node.
 * Network failures downgrade to `warn`, never `fail` - being offline is not a broken setup.
 */

export type KeyCurve = "ecdsa" | "ed25519" | "raw" | "unknown";

const MIRROR_NODE: Record<string, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

/** DER prefixes Hedera emits for each curve. */
const DER_ED25519 = "302e020100300506032b657004220420";
const DER_ECDSA = "3030020100300706052b8104000a04220420";

const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAccountId(raw: string): boolean {
  return ACCOUNT_ID.test(raw.trim());
}

export function looksLikeEvmAddress(raw: string): boolean {
  return EVM_ADDRESS.test(raw.trim());
}

/**
 * Classify a private key without parsing it. A bare 64 hex characters is valid for both curves,
 * so it is reported as `raw` rather than guessed at - the mirror node settles it below.
 */
export function classifyPrivateKey(raw: string): KeyCurve {
  const hex = raw.trim().replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return "unknown";
  if (hex.startsWith(DER_ED25519)) return "ed25519";
  if (hex.startsWith(DER_ECDSA)) return "ecdsa";
  if (hex.length === 64) return "raw";
  return "unknown";
}

interface MirrorAccount {
  account: string;
  balanceTinybar: number;
  keyType: string | null;
  deleted: boolean;
}

async function fetchAccount(
  network: string,
  accountId: string,
  fetchImpl: typeof fetch,
): Promise<MirrorAccount | null> {
  const base = MIRROR_NODE[network] ?? MIRROR_NODE.testnet;
  const res = await fetchImpl(`${base}/api/v1/accounts/${encodeURIComponent(accountId)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`mirror node responded ${res.status}`);

  const body = (await res.json()) as {
    account?: string;
    deleted?: boolean;
    balance?: { balance?: number };
    key?: { _type?: string };
  };
  return {
    account: body.account ?? accountId,
    balanceTinybar: body.balance?.balance ?? 0,
    keyType: body.key?._type ?? null,
    deleted: Boolean(body.deleted),
  };
}

const TINYBAR = 100_000_000;
const curveOfMirrorType = (t: string | null): KeyCurve =>
  t === "ECDSA_SECP256K1" ? "ecdsa" : t === "ED25519" ? "ed25519" : "unknown";

export interface ChainCredentialInput {
  accountIdEnv: string;
  privateKeyEnv: string;
  network: string;
  /** HBAR the run will move to the ephemeral signer, so the threshold is real, not arbitrary. */
  fundingHbar: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export async function checkChainCredentials(input: ChainCredentialInput): Promise<DoctorCheck[]> {
  const env = input.env ?? process.env;
  const fetchImpl = input.fetchImpl ?? fetch;
  const checks: DoctorCheck[] = [];

  const accountId = env[input.accountIdEnv]?.trim();
  const privateKey = env[input.privateKeyEnv]?.trim();

  // --- shape of the account id -----------------------------------------------------------------
  if (!accountId) {
    return [
      {
        name: "operator account",
        status: "fail",
        detail: `${input.accountIdEnv} is not set`,
        fix: `Set ${input.accountIdEnv} to a Hedera account id like 0.0.12345.`,
      },
    ];
  }

  if (!isAccountId(accountId)) {
    return [
      {
        name: "operator account",
        status: "fail",
        detail: looksLikeEvmAddress(accountId)
          ? `${input.accountIdEnv} holds an EVM address, not an account id`
          : `${input.accountIdEnv} is not shard.realm.num`,
        fix: looksLikeEvmAddress(accountId)
          ? `Hedera accounts have two identifiers. The SDK operator needs the account id (0.0.12345); the EVM address belongs in a JSON-RPC context.`
          : `Expected shard.realm.num, for example 0.0.12345.`,
      },
    ];
  }

  // --- key format --------------------------------------------------------------------------------
  const declaredCurve = privateKey ? classifyPrivateKey(privateKey) : "unknown";
  if (!privateKey) {
    checks.push({
      name: "operator key",
      status: "fail",
      detail: `${input.privateKeyEnv} is not set`,
      fix: `Set ${input.privateKeyEnv} to the operator private key (DER or raw hex).`,
    });
  } else if (declaredCurve === "unknown") {
    checks.push({
      name: "operator key",
      status: "fail",
      detail: `${input.privateKeyEnv} is not a recognisable Hedera private key`,
      fix: "Expected DER encoded hex, or 64 hex characters for a raw key. The value is never printed.",
    });
  }

  // --- the network's view --------------------------------------------------------------------------
  let account: MirrorAccount | null;
  try {
    account = await fetchAccount(input.network, accountId, fetchImpl);
  } catch (error) {
    checks.push({
      name: "mirror node",
      status: "warn",
      detail: `could not reach the ${input.network} mirror node`,
      fix: `${(error as Error).message}. Credentials were not verified against the network; the run may still work.`,
    });
    return checks;
  }

  if (!account) {
    checks.push({
      name: "operator account",
      status: "fail",
      detail: `${accountId} does not exist on ${input.network}`,
      fix: `The account is valid in form but unknown to ${input.network}. Accounts are per network - one created on mainnet does not exist on testnet.`,
    });
    return checks;
  }

  if (account.deleted) {
    checks.push({
      name: "operator account",
      status: "fail",
      detail: `${accountId} is deleted on ${input.network}`,
      fix: "Provision a new operator account.",
    });
    return checks;
  }

  checks.push({
    name: "operator account",
    status: "ok",
    detail: `${accountId} exists on ${input.network}`,
  });

  // --- curve agreement, the failure that costs the most time -------------------------------------
  const actualCurve = curveOfMirrorType(account.keyType);
  if (privateKey && declaredCurve !== "unknown") {
    if (declaredCurve === "raw") {
      checks.push({
        name: "operator key",
        status: "ok",
        detail: `raw hex; account is ${account.keyType ?? "an unknown key type"}`,
        fix:
          actualCurve === "ecdsa"
            ? "Load it with PrivateKey.fromStringECDSA - a raw key gives no hint and fromStringED25519 fails later as INVALID_SIGNATURE."
            : actualCurve === "ed25519"
              ? "Load it with PrivateKey.fromStringED25519."
              : undefined,
      });
    } else if (actualCurve !== "unknown" && declaredCurve !== actualCurve) {
      checks.push({
        name: "operator key",
        status: "fail",
        detail: `key is ${declaredCurve.toUpperCase()} but ${accountId} is ${account.keyType}`,
        fix: "The key does not match the account. Signing would fail at the first transaction with INVALID_SIGNATURE and nothing pointing at the key format.",
      });
    } else {
      checks.push({
        name: "operator key",
        status: "ok",
        detail: `${declaredCurve.toUpperCase()}, matching the account`,
      });
    }
  }

  // --- balance, against what the run will actually spend ------------------------------------------
  const hbar = account.balanceTinybar / TINYBAR;
  // The run funds an ephemeral signer and pays fees on both sides of it.
  const needed = input.fundingHbar + 1;
  checks.push(
    hbar >= needed
      ? { name: "operator balance", status: "ok", detail: `${hbar.toFixed(2)} HBAR` }
      : {
          name: "operator balance",
          status: hbar > 0 ? "warn" : "fail",
          detail: `${hbar.toFixed(2)} HBAR, run funds ${input.fundingHbar} plus fees`,
          fix:
            input.network === "testnet"
              ? "Top up at https://portal.hedera.com. A run that runs dry mid-flight fails after the agent budget is already spent."
              : "Fund the operator account before running.",
        },
  );

  return checks;
}
