import { readFile } from "node:fs/promises";
import type { ChainSigner, TemplateSpec, ValidationFinding } from "./types.js";
import {
  VENDORED_CONTRACT_PATH,
  VENDORED_PRD_PATH,
  type VendoredContext,
} from "./contextVendor.js";
import type { VendoredSkill } from "./skillVendor.js";
import { HARNESS_CONTEXT_DIR, HARNESS_SKILLS_DIR } from "./runtimePaths.js";
import { renderPrompt } from "./promptTemplates.js";

/**
 * Assembles prompt inputs; the prose lives in `prompts/*.md`.
 *
 * What stays here is the part that is genuinely logic — choosing a repair scope,
 * correlating findings with contract assertions, formatting lists. What left is
 * the wording, which is the thing most often tuned and the thing least served by
 * living behind a compile step.
 */
export type RepairScope = "semantic-scoped" | "runtime" | "broad";

interface ContractAssertion {
  id: string;
  journey?: string;
  route?: string;
  severity?: string;
  statement?: string;
  howToVerify?: string;
  walletRequired?: boolean;
}

const ASSERTION_ID_PATTERN = /\b(C\d+)\b/i;

interface ContextPaths {
  prdPath: string;
  contractPath: string;
  skillsRoot: string;
}

function runtimeContextPaths(
  vendoredSkills: VendoredSkill[],
  vendoredContext?: VendoredContext,
): ContextPaths {
  return {
    prdPath: vendoredContext?.prdRelativePath ?? `${HARNESS_CONTEXT_DIR}/prd.md`,
    contractPath:
      vendoredContext?.contractRelativePath ?? `${HARNESS_CONTEXT_DIR}/acceptance-contract.json`,
    skillsRoot:
      vendoredSkills[0]?.relativePath.split("/").slice(0, -2).join("/") || HARNESS_SKILLS_DIR,
  };
}

/** In-place run: inspect and preserve the existing app; implement the PRD feature. */
export async function buildSessionPrompt(
  spec: TemplateSpec,
  attempt: number,
  vendoredSkills: VendoredSkill[] = [],
  vendoredContext?: VendoredContext,
): Promise<string> {
  const prd = await readFile(spec.prdPaths[0], "utf8");
  const paths = runtimeContextPaths(vendoredSkills, vendoredContext);

  return renderPrompt(spec.projectRoot, "generator", {
    attempt: String(attempt),
    prd: prd.trim(),
    ...paths,
    hasContract: Boolean(spec.contractPath),
    hardConstraints: formatHardConstraints(spec),
    hasRequiredFiles: spec.requiredFiles.length > 0,
    requiredFiles: formatBulletList(spec.requiredFiles),
    hasSkills: vendoredSkills.length > 0,
    skillSummaries: formatSkillSummaries(vendoredSkills),
  });
}

/** Continue a run on the same harness branch, with a fresh-context agent. */
export async function buildSessionContinuePrompt(
  spec: TemplateSpec,
  cycle: number,
  vendoredSkills: VendoredSkill[] = [],
  vendoredContext?: VendoredContext,
): Promise<string> {
  const paths = runtimeContextPaths(vendoredSkills, vendoredContext);

  return renderPrompt(spec.projectRoot, "generator-continue", {
    cycle: String(cycle),
    ...paths,
    hasContract: Boolean(spec.contractPath),
    hardConstraints: formatHardConstraints(spec),
    hasRequiredFiles: spec.requiredFiles.length > 0,
    requiredFiles: formatBulletList(spec.requiredFiles),
    hasSkills: vendoredSkills.length > 0,
    skillSummaries: formatSkillSummaries(vendoredSkills),
  });
}

/** Repair prompt for an in-place run: preserve the app, fix the findings. */
export async function buildSessionRepairPrompt(
  spec: TemplateSpec,
  findings: ValidationFinding[],
  attempt: number,
  vendoredContext?: VendoredContext,
): Promise<string> {
  const [preamble, body] = await Promise.all([
    renderPrompt(spec.projectRoot, "repair-preamble", {}),
    buildRepairPrompt(spec, findings, attempt, vendoredContext),
  ]);
  return [preamble, "", body].join("\n");
}

/**
 * Build a scoped repair prompt.
 * - semantic-scoped: only contract assertion gaps (Tier 0–2 already green)
 * - runtime: yarn/playwright failures
 * - broad: structural/static/mixed failures
 */
export async function buildRepairPrompt(
  spec: TemplateSpec,
  findings: ValidationFinding[],
  attempt: number,
  vendoredContext?: VendoredContext,
): Promise<string> {
  const actionable = findings.filter(finding => finding.category !== "semantic-infra");
  const scope = classifyRepairScope(actionable);
  const contractPath = vendoredContext?.contractRelativePath ?? VENDORED_CONTRACT_PATH;
  const prdPath = vendoredContext?.prdRelativePath ?? VENDORED_PRD_PATH;
  const assertions = await loadContractAssertions(
    vendoredContext?.contractSourcePath ?? spec.contractPath,
  );

  const hasSemantic = actionable.some(finding => finding.category === "semantic");
  const shared = {
    attempt: String(attempt),
    prdPath,
    contractPath,
    hardConstraints: formatHardConstraints(spec),
    findingsList: formatFindingsList(actionable),
    hasSemantic,
    semanticTargets: formatSemanticTargets(actionable, assertions),
    hasContract: Boolean(spec.contractPath),
    hasMetadata: Boolean(
      spec.templateMetadata?.name ??
        spec.templateMetadata?.frontend ??
        spec.templateMetadata?.solidityFramework,
    ),
    metadata: formatMetadata(spec),
    hasRequiredFiles: spec.requiredFiles.length > 0,
    requiredFiles: formatBulletList(spec.requiredFiles),
  };

  if (scope === "semantic-scoped") {
    return renderPrompt(spec.projectRoot, "repair-semantic", shared);
  }
  if (scope === "runtime") {
    return renderPrompt(spec.projectRoot, "repair-runtime", {
      ...shared,
      hasSemanticContract: hasSemantic && Boolean(spec.contractPath),
    });
  }
  return renderPrompt(spec.projectRoot, "repair-broad", shared);
}

export function classifyRepairScope(findings: ValidationFinding[]): RepairScope {
  const actionable = findings.filter(finding => finding.category !== "semantic-infra");
  if (actionable.length === 0) {
    return "broad";
  }

  const categories = new Set(actionable.map(finding => finding.category));
  const onlySemantic = [...categories].every(category => category === "semantic");
  if (onlySemantic) {
    return "semantic-scoped";
  }

  const hasStructural = [...categories].some(category =>
    ["files", "static", "secret", "agent"].includes(category),
  );
  if (
    !hasStructural &&
    [...categories].every(category => ["commands", "playwright", "semantic"].includes(category))
  ) {
    if (categories.has("commands") || categories.has("playwright")) {
      return "runtime";
    }
  }

  return "broad";
}

export function extractAssertionId(finding: ValidationFinding): string | undefined {
  if (finding.contractAssertion) {
    return finding.contractAssertion.toUpperCase();
  }
  const fromMessage = finding.message.match(ASSERTION_ID_PATTERN);
  if (fromMessage) {
    return fromMessage[1].toUpperCase();
  }
  const fromId = finding.id.match(ASSERTION_ID_PATTERN);
  return fromId ? fromId[1].toUpperCase() : undefined;
}

export async function buildValidatorPrompt(
  spec: TemplateSpec,
  contractJson: string,
  serverUrl: string,
  chainSigner?: ChainSigner,
  browserLocalStorageKey = "burnerWallet.pk",
): Promise<string> {
  const outputSchema = {
    passed: true,
    summary: "Brief overall summary of the evaluation.",
    issues: [
      {
        id: "issue-slug",
        contractAssertion: "C1",
        severity: "critical",
        route: "/",
        message: "What failed and why.",
        evidence: "Route visited, elements observed, console output.",
      },
    ],
  };

  const walletRule = chainSigner
    ? [
        "- Assertions flagged executableWithTestSigner=true MUST be executed end-to-end with the harness test signer and verified on the Hedera testnet mirror node.",
        "- Other walletRequired assertions (without executableWithTestSigner) stay affordance-only: verify controls and no-wallet handling; do not require a completed on-chain tx.",
        "- Never use the test signer against mainnet.",
      ].join("\n")
    : "- For walletRequired assertions, do NOT complete on-chain transactions; verify affordances and no-wallet handling only.";

  return renderPrompt(spec.projectRoot, "validator", {
    serverUrl,
    contract: contractJson.trim(),
    outputSchema: JSON.stringify(outputSchema, null, 2),
    walletRule,
    hasSigner: Boolean(chainSigner),
    signerAccountId: chainSigner?.accountId,
    signerEvmAddress: chainSigner?.evmAddress,
    signerPrivateKey: chainSigner?.privateKeyHex,
    signerNetwork: chainSigner?.network,
    browserKey: browserLocalStorageKey,
  });
}

function formatBulletList(values: string[]): string {
  return values.map(value => `- ${value}`).join("\n");
}

function formatMetadata(spec: TemplateSpec): string {
  const metadata = spec.templateMetadata;
  return [
    metadata?.name ? `- template name: ${metadata.name}` : undefined,
    metadata?.frontend ? `- frontend capability: ${metadata.frontend}` : undefined,
    metadata?.solidityFramework
      ? `- solidity framework capability: ${metadata.solidityFramework}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatFindingsList(findings: ValidationFinding[]): string {
  if (findings.length === 0) {
    return "- (no findings)";
  }
  return findings
    .map(
      finding =>
        `- [${finding.category}] ${finding.message}${finding.details ? `\n  ${finding.details}` : ""}`,
    )
    .join("\n");
}

function formatSemanticTargets(
  findings: ValidationFinding[],
  assertions: Map<string, ContractAssertion>,
): string {
  const semantic = findings.filter(finding => finding.category === "semantic");
  if (semantic.length === 0) {
    return "- (no semantic findings)";
  }

  return semantic
    .map(finding => {
      const assertionId = extractAssertionId(finding);
      const fromContract = assertionId ? assertions.get(assertionId) : undefined;
      const route = finding.route ?? fromContract?.route;
      return [
        `### ${assertionId ?? finding.id}`,
        route ? `- route: \`${route}\`` : undefined,
        fromContract?.severity ? `- severity: ${fromContract.severity}` : undefined,
        fromContract?.journey ? `- journey: ${fromContract.journey}` : undefined,
        fromContract?.statement ? `- statement: ${fromContract.statement}` : undefined,
        fromContract?.howToVerify ? `- howToVerify: ${fromContract.howToVerify}` : undefined,
        `- validator message: ${finding.message}`,
        finding.details ? `- evidence: ${finding.details}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    })
    .join("\n\n");
}

async function loadContractAssertions(
  contractPath?: string,
): Promise<Map<string, ContractAssertion>> {
  const map = new Map<string, ContractAssertion>();
  if (!contractPath) {
    return map;
  }

  try {
    const raw = await readFile(contractPath, "utf8");
    const parsed = JSON.parse(raw) as { assertions?: ContractAssertion[] };
    for (const assertion of parsed.assertions ?? []) {
      if (assertion?.id) {
        map.set(assertion.id.toUpperCase(), assertion);
      }
    }
  } catch {
    // Contract missing/unreadable — repair still works with finding text only.
  }

  return map;
}

function formatHardConstraints(spec: TemplateSpec): string {
  return [
    "## Hard Constraints",
    "- Keep all changes inside the current workspace.",
    "- Use Yarn workspace commands only.",
    spec.constraints?.forbiddenWorkspaces?.length
      ? `- Forbidden workspaces: ${spec.constraints.forbiddenWorkspaces.join(", ")}`
      : undefined,
    spec.constraints?.forbiddenCommands?.length
      ? `- Forbidden commands: ${spec.constraints.forbiddenCommands.join(", ")}`
      : undefined,
    "- Do not add `.env` files, private keys, API keys, or live-network credential requirements.",
    "- Produce `template.json`, `README.md`, and `AGENTS.md` suitable for scaffold-hbar.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatSkillSummaries(skills: VendoredSkill[]): string {
  return skills
    .map(skill => {
      const refs = skill.referencesPath
        ? `\nReferences (read when needed): ${skill.referencesPath}/`
        : "";
      return `### ${skill.name}\nSource: ${skill.relativePath}${refs}\n${skill.description}`;
    })
    .join("\n\n");
}
