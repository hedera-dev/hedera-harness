export type ContractScope = "none" | "solidity";

const HEADER = /^Contracts:\s*(none|solidity)\s*$/im;

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

/** Default is none (payments / HCS / x402). Solidity only when the brief clearly needs it. */
export function inferContractScope(text: string): ContractScope {
  const explicit = parseContractScopeLine(text);
  if (explicit) return explicit;
  if (EXPLICIT_NONE.some(re => re.test(text))) return "none";
  if (POSITIVE_SOLIDITY.some(re => re.test(text))) return "solidity";
  return "none";
}

export function hardhatGate(scope: ContractScope): "skip" | "run" {
  return scope === "solidity" ? "run" : "skip";
}
