export type ContractScope = "none" | "solidity";

export type ContractBase =
  | "none"
  | "token"
  | "nft"
  | "escrow"
  | "payroll"
  | "vesting"
  | "governor"
  | "hts"
  | "custom";

export const CONTRACT_BASES: readonly ContractBase[] = [
  "none",
  "token",
  "nft",
  "escrow",
  "payroll",
  "vesting",
  "governor",
  "hts",
  "custom",
];

const HEADER = /^Contracts:\s*(none|solidity)\s*$/im;
const BASE_HEADER = /^ContractBase:\s*(none|token|nft|escrow|payroll|vesting|governor|hts|custom)\s*$/im;

/**
 * Positive Solidity signals only. Bare "hardhat" / "contract" is too noisy
 * (non-goals, "acceptance contract", "no Hardhat").
 */
const POSITIVE_SOLIDITY = [
  /solidityframework:\s*hardhat/i,
  /hts\s+precompile/i,
  /\b0x167\b/,
  /yarn\s+hardhat:(compile|deploy)/i,
  /packages\/hardhat\/.+\.sol/i,
  /write\s+(a|an|the)\s+(solidity|smart\s+contract)/i,
  /deploy(?:ed)?\s+(?:a|the)\s+(?:solidity\s+)?smart\s+contract/i,
  /\bescrow\s+contract\b/i,
  /\bpayroll\s+contract\b/i,
  /\bvesting\s+contract\b/i,
  /\bgovernor\s+contract\b/i,
];

const EXPLICIT_NONE = [
  /solidityframework:\s*none/i,
  /^Contracts:\s*none\s*$/im,
];

export function parseContractScopeLine(markdown: string): ContractScope | undefined {
  const match = markdown.match(HEADER);
  if (!match) return undefined;
  return match[1].toLowerCase() === "solidity" ? "solidity" : "none";
}

export function parseContractBaseLine(markdown: string): ContractBase | undefined {
  const match = markdown.match(BASE_HEADER);
  if (!match) return undefined;
  return match[1].toLowerCase() as ContractBase;
}

/** Default is none (payments / HCS / x402). Solidity only when the brief clearly needs it. */
export function inferContractScope(text: string): ContractScope {
  const explicit = parseContractScopeLine(text);
  if (explicit) return explicit;
  if (EXPLICIT_NONE.some(re => re.test(text))) return "none";
  if (POSITIVE_SOLIDITY.some(re => re.test(text))) return "solidity";
  return "none";
}

/** Shape of *our* Solidity, not an existing token on chain. none when Contracts is none. */
export function inferContractBase(text: string): ContractBase {
  const explicit = parseContractBaseLine(text);
  if (explicit) return explicit;
  if (inferContractScope(text) === "none") return "none";
  if (/\bhts\s+precompile\b|\b0x167\b/i.test(text)) return "hts";
  if (/\berc-?721\b|\bnft\b/i.test(text)) return "nft";
  if (/\berc-?20\b|\bfungible token\b/i.test(text)) return "token";
  if (/\bescrow\b/i.test(text)) return "escrow";
  if (/\bpayroll\b/i.test(text)) return "payroll";
  if (/\bvesting\b/i.test(text)) return "vesting";
  if (/\bgovernor\b|\bdao\b/i.test(text)) return "governor";
  return "custom";
}

/** OpenZeppelin Contracts MCP tool name, or undefined (use Hedera docs / no Solidity). */
export function ozMcpToolForBase(base: ContractBase): string | undefined {
  switch (base) {
    case "token":
      return "solidity-erc20";
    case "nft":
      return "solidity-erc721";
    case "governor":
      return "solidity-governor";
    case "escrow":
    case "payroll":
    case "vesting":
    case "custom":
      return "solidity-custom";
    default:
      return undefined;
  }
}

export function hardhatGate(scope: ContractScope): "skip" | "run" {
  return scope === "solidity" ? "run" : "skip";
}
