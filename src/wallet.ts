/**
 * The account the app signs with, supplied by whoever is running the harness.
 *
 * Deliberately not a signer. The harness creates no accounts, transfers
 * nothing, and sweeps nothing — the first transactional run showed why that
 * machinery exists and how to avoid needing it. The evaluator clicked Connect,
 * the app generated its own burner wallet, and funding *that* address was the
 * hard part: known only at runtime, and needing a signed transfer. Making the
 * supplied account be the wallet removes the step entirely, because a person
 * already funded it at the portal.
 *
 * So the harness holds the account id — to read a public balance — and passes
 * the key through to the evaluator without ever using it. No SDK, no
 * provisioning, and the key never enters the harness's own logic.
 */
/** Below this the account cannot pay for much, and a run is not worth starting. */
const ENOUGH_TINYBARS = 5 * 100_000_000;

/** Which network, and where its public reads come from. Shared by DOCTOR and EVALUATE. */
export function network(): string {
  return process.env["HEDERA_NETWORK"] ?? "testnet";
}

export function mirrorNode(): string {
  const chosen = network();
  return (
    process.env["HEDERA_MIRROR_NODE"] ??
    (chosen === "mainnet"
      ? "https://mainnet-public.mirrornode.hedera.com"
      : `https://${chosen}.mirrornode.hedera.com`)
  );
}

export interface Wallet {
  /** `0.0.1234` — what the harness checks, and all it needs. */
  id: string;
  /** Handed to the evaluator, never used here, never written to an artifact. */
  key: string;
}

/** The wallet a run was given, or null when none was. Transactional specs need one. */
export function wallet(): Wallet | null {
  const id = process.env["HEDERA_OPERATOR_ID"];
  const key = process.env["HEDERA_OPERATOR_KEY"];
  return id === undefined || key === undefined ? null : { id, key };
}

export type Funding =
  | { state: "ok"; hbar: number }
  | { state: "low"; hbar: number }
  | { state: "missing"; reason: string };

/**
 * Whether the account exists and can pay for anything, read from the mirror
 * node over plain HTTP. A dry or mistyped account should cost four seconds
 * here rather than forty minutes and a confusing verdict later.
 */
export async function funding(mirrorNode: string, id: string): Promise<Funding> {
  const found = await read(mirrorNode, `accounts/${id}`, "balance.balance");
  if ("error" in found) return { state: "missing", reason: found.error };

  const tinybars = Number(found.value);
  if (Number.isNaN(tinybars)) return { state: "missing", reason: `${id} reports no balance` };

  const hbar = tinybars / 100_000_000;
  return tinybars >= ENOUGH_TINYBARS ? { state: "ok", hbar } : { state: "low", hbar };
}

/**
 * Reads `field` out of the mirror node's answer for `path`. The one harness-side
 * chain read that survives the move to judge-side verification: this is
 * preflight — "can the account pay for a run" — asked of a public API before
 * anything starts, not evidence about what an agent did.
 */
async function read(
  mirrorNode: string,
  path: string,
  field: string,
): Promise<{ value: unknown } | { error: string }> {
  const url = `${mirrorNode.replace(/\/$/, "")}/api/v1/${path.replace(/^\//, "")}`;
  const response = await fetch(url).catch((error: Error) => error);
  if (response instanceof Error) return { error: `${url} could not be reached: ${response.message}` };
  if (!response.ok) return { error: `${url} answered ${response.status}` };

  const body = (await response.json().catch(() => null)) as unknown;
  if (body === null) return { error: `${url} did not answer with JSON` };

  const value = field.split(".").reduce<unknown>(
    (into, key) => (into !== null && typeof into === "object" ? (into as Record<string, unknown>)[key] : undefined),
    body,
  );
  return value === undefined ? { error: `${url} has no ${field}` } : { value };
}

/**
 * Removes the key from anything about to be written down.
 *
 * The key reaches the evaluator, so it reaches the transcript — we record every
 * message the agent sent and received, which is exactly the artifact a key must
 * never survive in. v2 had only prompt files to clean; this is the sharper
 * version of the same problem, and the reason redaction happens at the write
 * rather than being left to the agent's discretion.
 */
export function redact(text: string, key: string | undefined): string {
  if (key === undefined || key.length < 8) return text;
  return text.split(key).join("«redacted»");
}
