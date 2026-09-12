export const DEFAULT_MIRROR_URL = "https://testnet.mirrornode.hedera.com";

export function scenarioMirrorUrl(): string {
  const override = process.env.HARNESS_MIRROR_BASE_URL?.trim();
  return (override || DEFAULT_MIRROR_URL).replace(/\/+$/, "");
}

export async function fetchJson(pathAndQuery: string): Promise<unknown> {
  const url = `${scenarioMirrorUrl()}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Mirror request failed ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

export async function pollUntil<T>(
  label: string,
  load: () => Promise<T | undefined>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 1500;
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const value = await load();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (index < attempts - 1) {
      await sleep(delayMs);
    }
  }
  const extra = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Mirror never observed ${label} after ${attempts} polls.${extra}`);
}

export function parseAccountHbar(json: unknown): number {
  const record = asRecord(json, "account");
  const tinybars = Number(record.balance && typeof record.balance === "object"
    ? (record.balance as { balance?: unknown }).balance
    : record.balance);
  if (!Number.isFinite(tinybars)) {
    throw new Error("Mirror account is missing a numeric balance.");
  }
  return tinybars / 100_000_000;
}

export function parseTokenBalance(json: unknown, tokenId: string): number {
  const record = asRecord(json, "tokens");
  const rows = Array.isArray(record.tokens) ? record.tokens : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    if (String(entry.token_id) === tokenId) {
      return Number(entry.balance ?? 0);
    }
  }
  return 0;
}

export function parseTopicContains(json: unknown, needle: string): boolean {
  const record = asRecord(json, "topic messages");
  const rows = Array.isArray(record.messages) ? record.messages : [];
  return rows.some(row => {
    if (!row || typeof row !== "object") return false;
    const encoded = (row as { message?: unknown }).message;
    if (typeof encoded !== "string") return false;
    return Buffer.from(encoded, "base64").toString("utf8").includes(needle);
  });
}

export function parsePendingAirdrop(
  json: unknown,
  tokenId: string,
): { senderId: string; tokenId: string } | undefined {
  const record = asRecord(json, "pending airdrops");
  const rows = Array.isArray(record.airdrops) ? record.airdrops : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    if (String(entry.token_id) !== tokenId) continue;
    const senderId = String(entry.sender_id ?? entry.sender_account_id ?? "");
    if (!senderId) continue;
    return { senderId, tokenId };
  }
  return undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected a JSON object for ${label}.`);
  }
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
