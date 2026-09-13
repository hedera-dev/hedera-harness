/**
 * Issuer token facades for GENERATE.
 *
 * Built-in cache (Circle USDC) plus per-app `.harness/tokens.json`.
 * Unknown symbols are `token=lookup` — SearchHedera first, then webfetch
 * the issuer, convert 0.0.x → long-zero 0x, remember, bake. Never invent.
 * Never leave NEXT_PUBLIC_* as the only source.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type HederaTokenNetwork = "testnet" | "mainnet";

export interface HederaListedToken {
  symbol: string;
  network: HederaTokenNetwork;
  chainId: number;
  htsId: string;
  decimals: number;
  source: string;
}

export interface ResolvedHederaToken extends HederaListedToken {
  evm: string;
}

export const WORKSPACE_TOKENS_REL = [".harness", "tokens.json"] as const;

export const HEDERA_TOKEN_REGISTRY: readonly HederaListedToken[] = [
  {
    symbol: "USDC",
    network: "testnet",
    chainId: 296,
    htsId: "0.0.429274",
    decimals: 6,
    source: "Circle",
  },
  {
    symbol: "USDC",
    network: "mainnet",
    chainId: 295,
    htsId: "0.0.456858",
    decimals: 6,
    source: "Circle",
  },
];

export function chainIdForNetwork(network: HederaTokenNetwork): number {
  return network === "mainnet" ? 295 : 296;
}

export function workspaceTokensPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...WORKSPACE_TOKENS_REL);
}

/** HIP-218 / long-zero: pad the token number to 20 bytes. */
export function htsTokenNumToEvmAddress(tokenNum: number): string {
  if (!Number.isInteger(tokenNum) || tokenNum < 0) {
    throw new Error(`Invalid HTS token number ${tokenNum}`);
  }
  return `0x${tokenNum.toString(16).padStart(40, "0")}`;
}

export function parseHtsId(htsId: string): number {
  const parts = htsId.trim().split(".");
  const raw = parts.length === 3 ? parts[2] : parts[0];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid HTS id ${htsId}`);
  }
  return n;
}

export function convertHtsIdToEvm(htsId: string): string {
  return htsTokenNumToEvmAddress(parseHtsId(htsId));
}

export function formatConvertHtsId(htsId: string, network: HederaTokenNetwork = "testnet"): string {
  try {
    const evm = convertHtsIdToEvm(htsId);
    return [
      "action=convert",
      `hts_id=${htsId.trim()}`,
      `evm=${evm}`,
      `network=${network}`,
      `chain_id=${chainIdForNetwork(network)}`,
      "note=HIP-218 long-zero. Bake evm= then harness_tokens action=remember.",
    ].join("\n");
  } catch (error) {
    return [
      "action=convert",
      "token=fail",
      `hts_id=${htsId}`,
      `note=${error instanceof Error ? error.message : String(error)}`,
    ].join("\n");
  }
}

export function loadWorkspaceTokens(workspaceDir: string): ResolvedHederaToken[] {
  const file = workspaceTokensPath(workspaceDir);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: unknown };
    if (!Array.isArray(parsed.tokens)) return [];
    const out: ResolvedHederaToken[] = [];
    for (const row of parsed.tokens) {
      const token = normalizeStoredToken(row);
      if (token) out.push(token);
    }
    return out;
  } catch {
    return [];
  }
}

export function resolveListedToken(
  symbol = "USDC",
  network: HederaTokenNetwork = "testnet",
  workspaceDir?: string,
): ResolvedHederaToken | undefined {
  const wanted = symbol.trim().toUpperCase();
  if (workspaceDir) {
    const local = loadWorkspaceTokens(workspaceDir).find(
      token => token.symbol === wanted && token.network === network,
    );
    if (local) return local;
  }
  const hit = HEDERA_TOKEN_REGISTRY.find(
    token => token.symbol === wanted && token.network === network,
  );
  if (!hit) return undefined;
  return { ...hit, evm: convertHtsIdToEvm(hit.htsId) };
}

export function rememberWorkspaceToken(
  workspaceDir: string,
  input: {
    symbol: string;
    network?: HederaTokenNetwork;
    htsId?: string;
    evm?: string;
    decimals?: number;
    source?: string;
  },
): ResolvedHederaToken {
  const network = input.network ?? "testnet";
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) throw new Error("symbol is required to remember a token.");
  const htsId = input.htsId?.trim() || "";
  let evm = (input.evm ?? "").trim().toLowerCase();
  if (htsId) {
    const fromHts = convertHtsIdToEvm(htsId).toLowerCase();
    if (evm && evm !== fromHts) {
      throw new Error(`evm ${input.evm} does not match HIP-218 of ${htsId} (${fromHts}).`);
    }
    evm = fromHts;
  }
  if (!/^0x[a-f0-9]{40}$/.test(evm)) {
    throw new Error("remember needs hts_id=0.0.x and/or a 20-byte 0x evm address.");
  }
  const stored: ResolvedHederaToken = {
    symbol,
    network,
    chainId: chainIdForNetwork(network),
    htsId: htsId || "",
    evm,
    decimals: input.decimals && input.decimals > 0 ? input.decimals : 6,
    source: input.source?.trim() || "webfetch",
  };
  const rest = loadWorkspaceTokens(workspaceDir).filter(
    token => !(token.symbol === stored.symbol && token.network === stored.network),
  );
  const next = [...rest, stored];
  const file = workspaceTokensPath(workspaceDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ tokens: next }, null, 2)}\n`, "utf8");
  return stored;
}

export function formatResolvedToken(token: ResolvedHederaToken, extraNote?: string): string {
  return [
    `token=${token.symbol}`,
    `network=${token.network}`,
    `chain_id=${token.chainId}`,
    token.htsId ? `hts_id=${token.htsId}` : undefined,
    `evm=${token.evm}`,
    `decimals=${token.decimals}`,
    `source=${token.source}`,
    extraNote ??
      "note=Bake evm= in the app (env may override). Destination must already be associated.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatTokenLookup(
  symbol: string,
  network: HederaTokenNetwork,
  workspaceDir?: string,
): string {
  const token = resolveListedToken(symbol, network, workspaceDir);
  if (token) return formatResolvedToken(token);
  const asked = `${symbol.trim().toUpperCase() || "USDC"}/${network}`;
  return [
    "token=lookup",
    `asked=${asked}`,
    `searchhedera=${asked} Hedera token id HTS testnet`,
    "webfetch=issuer registry (Circle, HashScan, SaucerSwap) only after SearchHedera is empty/fail",
    "then=harness_tokens action=convert hts_id=0.0.x",
    "then=harness_tokens action=remember symbol=… hts_id=… (bakes .harness/tokens.json)",
    "then=bake evm= as a constant in the app",
    "note=Do not invent a 0x. Do not ask the human unless both MCP and webfetch failed.",
  ].join("\n");
}

export function formatRememberWorkspaceToken(
  workspaceDir: string,
  input: {
    symbol: string;
    network?: HederaTokenNetwork;
    htsId?: string;
    evm?: string;
    decimals?: number;
    source?: string;
  },
): string {
  try {
    const stored = rememberWorkspaceToken(workspaceDir, input);
    return formatResolvedToken(
      stored,
      "note=Saved .harness/tokens.json. Bake evm= in the app (env may override).",
    );
  } catch (error) {
    return [
      "token=fail",
      "action=remember",
      `note=${error instanceof Error ? error.message : String(error)}`,
    ].join("\n");
  }
}
export function formatTokenRegistry(
  symbol?: string,
  network: HederaTokenNetwork = "testnet",
  workspaceDir?: string,
): string {
  return formatTokenLookup(symbol || "USDC", network, workspaceDir);
}

function normalizeStoredToken(row: unknown): ResolvedHederaToken | undefined {
  if (!row || typeof row !== "object") return undefined;
  const rec = row as Record<string, unknown>;
  const symbol = String(rec.symbol || "").trim().toUpperCase();
  const network = rec.network === "mainnet" ? "mainnet" : "testnet";
  const htsId = String(rec.htsId || rec.hts_id || "").trim();
  let evm = String(rec.evm || "").trim().toLowerCase();
  if (htsId && !evm) {
    try {
      evm = convertHtsIdToEvm(htsId).toLowerCase();
    } catch {
      return undefined;
    }
  }
  if (!symbol || !/^0x[a-f0-9]{40}$/.test(evm)) return undefined;
  return {
    symbol,
    network,
    chainId: typeof rec.chainId === "number" ? rec.chainId : chainIdForNetwork(network),
    htsId,
    evm,
    decimals: typeof rec.decimals === "number" && rec.decimals > 0 ? rec.decimals : 6,
    source: String(rec.source || "workspace"),
  };
}
