import { readFile } from "node:fs/promises";
import type { TemplateSpec, ValidationFinding } from "./types.js";
import {
  VENDORED_CONTRACT_PATH,
  VENDORED_PRD_PATH,
  type VendoredContext,
} from "./contextVendor.js";
import type { VendoredSkill } from "./skillVendor.js";
import { HARNESS_CONTEXT_DIR, HARNESS_SKILLS_DIR } from "./runtimePaths.js";

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

export async function buildGeneratorPrompt(
  spec: TemplateSpec,
  attempt: number,
  vendoredSkills: VendoredSkill[] = [],
): Promise<string> {
  const prd = await readFile(spec.prdPath, "utf8");
  const skillSummaries = formatSkillSummaries(vendoredSkills);
  const metadata = spec.templateMetadata;

  return [
    "You are the generator agent for a scaffold-hbar template harness.",
    "",
    `Attempt: ${attempt}`,
    "",
    "## Product Requirements",
    prd.trim(),
    "",
    "## Harness Mission",
    "Transform the seeded scaffold-hbar workspace into a working Hedera ecosystem demo template.",
    "Be creative in implementation choices while respecting the constraints below.",
    "Do not assume any pre-existing finished template. Build the best version you can from the seed.",
    "Do not read or copy from repositories, harness runs, or template branches outside this workspace.",
    "",
    "## Workspace Context Files",
    `The PRD is also vendored at \`${VENDORED_PRD_PATH}\` for later repair attempts.`,
    spec.contractPath
      ? `The acceptance contract is vendored at \`${VENDORED_CONTRACT_PATH}\`.`
      : undefined,
    "",
    "## Template Metadata Targets",
    metadata?.name ? `- template name: ${metadata.name}` : undefined,
    metadata?.frontend ? `- frontend capability: ${metadata.frontend}` : undefined,
    metadata?.solidityFramework
      ? `- solidity framework capability: ${metadata.solidityFramework}`
      : undefined,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Required Deliverables",
    ...spec.requiredFiles.map(file => `- ${file}`),
    "",
    "## Skills To Leverage",
    skillSummaries.length > 0
      ? [
          "Use only the vendored skills copied into this workspace under `.harness-skills/`.",
          skillSummaries,
        ].join("\n\n")
      : "- Use scaffold-hbar and Hedera best practices.",
    "",
    "## Logging Requirement",
    "After making meaningful changes, append a short note to `GENERATION_NOTES.md` at the workspace root. Summarize what you built, what you validated, and what remains risky.",
    "- Do not read or write files outside the current workspace.",
    "",
    "## Completion Standard",
    "The workspace should pass deterministic validation: required files present, forbidden files absent, no secrets, and yarn lint/typecheck/build commands succeeding without live credentials.",
    spec.validators.playwrightPath
      ? "When build passes, the harness also runs a thin Playwright gate (dev server boots, routes render, no console errors)."
      : undefined,
    spec.validator && spec.validator.enabled !== false
      ? "When deterministic and Playwright gates pass, a read-only validator agent grades the live app against the acceptance contract."
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * In-place extend: inspect and preserve the existing app; implement the PRD extension.
 */
export async function buildSessionPrompt(
  spec: TemplateSpec,
  attempt: number,
  vendoredSkills: VendoredSkill[] = [],
  vendoredContext?: VendoredContext,
): Promise<string> {
  const prd = await readFile(spec.prdPath, "utf8");
  const skillSummaries = formatSkillSummaries(vendoredSkills);
  const prdPath = vendoredContext?.prdRelativePath ?? `${HARNESS_CONTEXT_DIR}/prd.md`;
  const contractPath =
    vendoredContext?.contractRelativePath ?? `${HARNESS_CONTEXT_DIR}/acceptance-contract.json`;
  const skillsRoot =
    vendoredSkills[0]?.relativePath.split("/").slice(0, -2).join("/") || HARNESS_SKILLS_DIR;

  return [
    "You are the extension agent for an existing scaffold-hbar application.",
    "Work directly in the current project directory (this is not a fresh seed).",
    "",
    `Attempt: ${attempt}`,
    "",
    "## Product Requirements (extension brief)",
    prd.trim(),
    "",
    "## Extension Mission",
    "Inspect the existing application first. Preserve working structure, conventions, and unrelated features.",
    "Implement the requested extension described in the PRD — do NOT rebuild the app from scratch.",
    "Prefer targeted edits and additive changes over rewrites.",
    "Do not read or copy from harness run directories, seed clones, or repositories outside this workspace.",
    "",
    "## Workspace Context Files (ignored runtime; do not commit)",
    `The PRD is vendored at \`${prdPath}\`.`,
    spec.contractPath ? `The acceptance contract is vendored at \`${contractPath}\`.` : undefined,
    `Skills (if any) are under \`${skillsRoot}/\`.`,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Required Deliverables",
    ...spec.requiredFiles.map(file => `- ${file}`),
    "",
    "## Skills To Leverage",
    skillSummaries.length > 0
      ? [`Use only the vendored skills under \`${skillsRoot}/\`.`, skillSummaries].join("\n\n")
      : "- Use scaffold-hbar and Hedera best practices.",
    "",
    "## Logging Requirement",
    "After making meaningful changes, append a short note to `GENERATION_NOTES.md` at the workspace root.",
    "- Do not read or write files outside the current workspace.",
    "- Do not delete or rewrite unrelated existing features.",
    "",
    "## Completion Standard",
    "The extended app should pass the extension's deterministic validators and any enabled Playwright/semantic gates.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Continue a project-centric `run` session on the same harness branch.
 */
export async function buildSessionContinuePrompt(
  spec: TemplateSpec,
  cycle: number,
  vendoredSkills: VendoredSkill[] = [],
  vendoredContext?: VendoredContext,
): Promise<string> {
  const skillSummaries = formatSkillSummaries(vendoredSkills);
  const prdPath = vendoredContext?.prdRelativePath ?? `${HARNESS_CONTEXT_DIR}/prd.md`;
  const contractPath =
    vendoredContext?.contractRelativePath ?? `${HARNESS_CONTEXT_DIR}/acceptance-contract.json`;
  const skillsRoot =
    vendoredSkills[0]?.relativePath.split("/").slice(0, -2).join("/") || HARNESS_SKILLS_DIR;

  return [
    "You are continuing an in-place extension of an existing scaffold-hbar application.",
    "This is a fresh-context agent run on the same harness extend branch.",
    "",
    `Continue cycle: ${cycle}`,
    "",
    "## Read First (Updated Inputs)",
    "The harness re-vendored the latest extension brief into ignored runtime paths:",
    `- \`${prdPath}\` — updated extension requirements`,
    spec.contractPath ? `- \`${contractPath}\` — acceptance assertions` : undefined,
    `- \`${skillsRoot}/\` — vendored skills (if any)`,
    "- `GENERATION_NOTES.md` — prior notes",
    "",
    "## Mission",
    "Improve the **existing** application to finish the extension.",
    "Do NOT rebuild from scratch or wipe unrelated working features.",
    "Prefer targeted edits that close gaps against the PRD/contract.",
    "",
    ...formatHardConstraints(spec),
    "",
    "## Required Deliverables",
    ...spec.requiredFiles.map(file => `- ${file}`),
    "",
    "## Skills To Leverage",
    skillSummaries.length > 0
      ? [`Use only the vendored skills under \`${skillsRoot}/\`.`, skillSummaries].join("\n\n")
      : "- Use scaffold-hbar and Hedera best practices.",
    "",
    "## Completion Standard",
    "Pass deterministic validation and any enabled Playwright + semantic contract checks.",
    "",
    "Append a brief note to `GENERATION_NOTES.md` describing what you changed for this continue cycle.",
    "- Do not read or write files outside the current workspace.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/**
 * Repair prompt for project-centric `run` (preserves existing app; uses runtime context paths).
 */
export async function buildSessionRepairPrompt(
  spec: TemplateSpec,
  findings: ValidationFinding[],
  attempt: number,
  vendoredContext?: VendoredContext,
): Promise<string> {
  const prompt = await buildRepairPrompt(spec, findings, attempt);
  return [
    "You are repairing an in-place extension of an existing application.",
    "Preserve unrelated working features. Prefer the smallest fix that clears the findings.",
    "",
    prompt,
  ].join("\n");
}

/**
 * First prompt of a --continue kick: improve the existing workspace against an updated PRD/contract.
 */
export async function buildContinuePrompt(
  spec: TemplateSpec,
  cycle: number,
  vendoredSkills: VendoredSkill[] = [],
): Promise<string> {
  const metadata = spec.templateMetadata;
  const skillSummaries = formatSkillSummaries(vendoredSkills);

  return [
    "You are continuing work on an existing scaffold-hbar template in the current workspace.",
    "This is a fresh-context agent run. You do not retain memory from prior agent runs.",
    "",
    `Continue cycle: ${cycle}`,
    "",
    "## Read First (Updated Inputs)",
    "The harness re-vendored the latest product brief and acceptance contract into the workspace:",
    `- \`${VENDORED_PRD_PATH}\` — updated product requirements (may have changed since the last kick)`,
    spec.contractPath
      ? `- \`${VENDORED_CONTRACT_PATH}\` — numbered acceptance assertions the validator will grade against`
      : undefined,
    "- `GENERATION_NOTES.md` — prior generator/repair notes",
    "",
    "## Mission",
    "Improve the **existing** app to match the updated PRD and pass validation.",
    "Do NOT rebuild from scratch or wipe unrelated working features.",
    "Prefer targeted edits: align UI/copy/flows to new or changed contract assertions, fix gaps, polish what already works.",
    "",
    "## Template Metadata Targets",
    metadata?.name ? `- template name: ${metadata.name}` : undefined,
    metadata?.frontend ? `- frontend capability: ${metadata.frontend}` : undefined,
    metadata?.solidityFramework
      ? `- solidity framework capability: ${metadata.solidityFramework}`
      : undefined,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Required Deliverables",
    ...spec.requiredFiles.map(file => `- ${file}`),
    "",
    "## Skills To Leverage",
    skillSummaries.length > 0
      ? [
          "Use only the vendored skills under `.harness-skills/`.",
          skillSummaries,
        ].join("\n\n")
      : "- Use scaffold-hbar and Hedera best practices.",
    "",
    "## Completion Standard",
    "Pass deterministic validation (files, yarn lint/build) and any enabled Playwright + semantic contract checks.",
    spec.contractPath
      ? "Read the acceptance contract and ensure the running app satisfies every assertion."
      : undefined,
    "",
    "Append a brief note to `GENERATION_NOTES.md` describing what you changed for this continue cycle.",
    "- Do not read or write files outside the current workspace.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
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

  if (scope === "semantic-scoped") {
    return buildSemanticScopedRepairPrompt({
      spec,
      findings: actionable,
      attempt,
      contractPath,
      prdPath,
      assertions,
    });
  }

  if (scope === "runtime") {
    return buildRuntimeRepairPrompt({
      spec,
      findings: actionable,
      attempt,
      contractPath,
      prdPath,
      assertions,
    });
  }

  return buildBroadRepairPrompt({
    spec,
    findings: actionable,
    attempt,
    contractPath,
    prdPath,
    assertions,
  });
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
  if (!hasStructural && [...categories].every(category => ["commands", "playwright", "semantic"].includes(category))) {
    const hasRuntime = categories.has("commands") || categories.has("playwright");
    if (hasRuntime) {
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

function buildSemanticScopedRepairPrompt(input: {
  spec: TemplateSpec;
  findings: ValidationFinding[];
  attempt: number;
  contractPath: string;
  prdPath: string;
  assertions: Map<string, ContractAssertion>;
}): string {
  const { spec, findings, attempt, contractPath, prdPath, assertions } = input;
  const targets = formatSemanticTargets(findings, assertions);

  return [
    "You are repairing a scaffold-hbar template in the current workspace.",
    "This is a fresh-context repair attempt. You do not retain memory from prior agent runs.",
    "",
    `Repair attempt: ${attempt}`,
    "Repair scope: **semantic-scoped** (deterministic checks and Playwright gate already passed).",
    "",
    "## Read First (Workspace Memory)",
    "Before changing anything, read:",
    `- \`${contractPath}\` — focus on the failed assertion ids listed below`,
    "- `GENERATION_NOTES.md` — prior notes (create if missing)",
    `- Skim \`${prdPath}\` only if you need product wording; do not redesign from the full PRD`,
    "",
    "## Repair Mission",
    "Fix ONLY the failed acceptance-contract assertions below.",
    "Do not redesign unrelated routes, rewrite architecture, or re-litigate Tier 0–2 work.",
    "Prefer small, local UI/copy/state fixes on the cited routes.",
    "",
    "## Failed Assertions (fix these)",
    targets,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Repair Rules",
    "- Keep Yarn-only workflows; do not add secrets or `.env` files.",
    "- Preserve scaffold-hbar template conventions.",
    "- Do NOT attempt to fix harness/tooling (MCP/browser) issues.",
    "- After edits, mentally re-check each listed assertion using its howToVerify steps.",
    "",
    "Append a brief repair note to `GENERATION_NOTES.md` listing which assertion ids you fixed.",
    "- Do not read or write files outside the current workspace.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildRuntimeRepairPrompt(input: {
  spec: TemplateSpec;
  findings: ValidationFinding[];
  attempt: number;
  contractPath: string;
  prdPath: string;
  assertions: Map<string, ContractAssertion>;
}): string {
  const { spec, findings, attempt, contractPath, prdPath, assertions } = input;
  const metadata = spec.templateMetadata;
  const hasSemantic = findings.some(finding => finding.category === "semantic");

  return [
    "You are repairing a scaffold-hbar template in the current workspace.",
    "This is a fresh-context repair attempt. You do not retain memory from prior agent runs.",
    "",
    `Repair attempt: ${attempt}`,
    "Repair scope: **runtime** (lint/build and/or Playwright gate failures).",
    "",
    "## Read First (Workspace Memory)",
    "Before changing anything, read:",
    "- `GENERATION_NOTES.md` — prior notes (create if missing)",
    `- \`${prdPath}\` — only as needed for intended behavior`,
    hasSemantic && spec.contractPath
      ? `- \`${contractPath}\` — only the failed assertion ids if listed below`
      : undefined,
    "",
    "## Repair Mission",
    "Restore a green build and thin Playwright gate first. Fix compile, lint, and route runtime errors before any polish.",
    "Do not redesign unrelated features.",
    "",
    "## Template Metadata Targets",
    metadata?.name ? `- template name: ${metadata.name}` : undefined,
    metadata?.frontend ? `- frontend capability: ${metadata.frontend}` : undefined,
    metadata?.solidityFramework
      ? `- solidity framework capability: ${metadata.solidityFramework}`
      : undefined,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Validation Findings",
    formatFindingsList(findings),
    hasSemantic ? ["", "## Failed Assertions (also fix if listed)", formatSemanticTargets(findings, assertions)].join("\n") : undefined,
    "",
    "## Repair Rules",
    "- Keep Yarn-only workflows; do not add secrets or `.env` files.",
    "- Preserve scaffold-hbar template conventions.",
    "- Priority: [commands] → [playwright] → [semantic].",
    "- Do NOT attempt to fix [semantic-infra] / MCP tooling failures.",
    "",
    "Append a brief repair note to `GENERATION_NOTES.md`.",
    "- Do not read or write files outside the current workspace.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildBroadRepairPrompt(input: {
  spec: TemplateSpec;
  findings: ValidationFinding[];
  attempt: number;
  contractPath: string;
  prdPath: string;
  assertions: Map<string, ContractAssertion>;
}): string {
  const { spec, findings, attempt, contractPath, prdPath, assertions } = input;
  const metadata = spec.templateMetadata;
  const hasSemantic = findings.some(finding => finding.category === "semantic");

  return [
    "You are repairing a scaffold-hbar template in the current workspace.",
    "This is a fresh-context repair attempt. You do not retain memory from prior agent runs.",
    "",
    `Repair attempt: ${attempt}`,
    "Repair scope: **broad** (structural and/or mixed validation failures).",
    "",
    "## Read First (Workspace Memory)",
    "Before changing anything, read these files in the current workspace:",
    `- \`${prdPath}\` — product requirements`,
    spec.contractPath ? `- \`${contractPath}\` — numbered acceptance assertions the validator will grade against` : undefined,
    "- `GENERATION_NOTES.md` — prior generator/repair notes (create it if missing)",
    "",
    "## Repair Mission",
    "Fix only the validation findings below. Do not redesign unrelated parts of the app.",
    "",
    "## Template Metadata Targets",
    metadata?.name ? `- template name: ${metadata.name}` : undefined,
    metadata?.frontend ? `- frontend capability: ${metadata.frontend}` : undefined,
    metadata?.solidityFramework
      ? `- solidity framework capability: ${metadata.solidityFramework}`
      : undefined,
    "",
    ...formatHardConstraints(spec),
    "",
    "## Required Deliverables",
    ...spec.requiredFiles.map(file => `- ${file}`),
    "",
    "## Validation Findings",
    formatFindingsList(findings),
    hasSemantic
      ? ["", "## Failed Assertions (detail)", formatSemanticTargets(findings, assertions)].join("\n")
      : undefined,
    "",
    "## Repair Rules",
    "- Keep Yarn-only workflows.",
    "- Do not add secrets or `.env` files.",
    "- Preserve scaffold-hbar template conventions.",
    "- Fix findings in priority order: [agent] process failures, [commands] build/lint, [playwright] runtime gate, [semantic] contract assertions, then [files]/[static]/[secret].",
    "- Do NOT attempt to fix [semantic-infra] findings — those are harness/tooling failures (MCP/browser), not app defects.",
    "- Re-run the relevant validation mentally before finishing.",
    "",
    "Append a brief repair note to `GENERATION_NOTES.md` at the workspace root, describing what failed and what you changed.",
    "- Do not read or write files outside the current workspace.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function formatFindingsList(findings: ValidationFinding[]): string {
  if (findings.length === 0) {
    return "- (no findings)";
  }
  return findings
    .map(finding => `- [${finding.category}] ${finding.message}${finding.details ? `\n  ${finding.details}` : ""}`)
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
      const lines = [
        `### ${assertionId ?? finding.id}`,
        route ? `- route: \`${route}\`` : undefined,
        fromContract?.severity ? `- severity: ${fromContract.severity}` : undefined,
        fromContract?.journey ? `- journey: ${fromContract.journey}` : undefined,
        fromContract?.statement ? `- statement: ${fromContract.statement}` : undefined,
        fromContract?.howToVerify ? `- howToVerify: ${fromContract.howToVerify}` : undefined,
        `- validator message: ${finding.message}`,
        finding.details ? `- evidence: ${finding.details}` : undefined,
      ];
      return lines.filter((line): line is string => Boolean(line)).join("\n");
    })
    .join("\n\n");
}

async function loadContractAssertions(contractPath?: string): Promise<Map<string, ContractAssertion>> {
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

function formatHardConstraints(spec: TemplateSpec): string[] {
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
  ].filter((line): line is string => Boolean(line));
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

export function buildValidatorPrompt(
  contractJson: string,
  serverUrl: string,
  chainSigner?: {
    accountId: string;
    privateKeyHex: string;
    evmAddress: string;
    network: "testnet";
  },
  browserLocalStorageKey = "burnerWallet.pk",
): string {
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

  const hasTestSigner = Boolean(chainSigner);
  const walletRule = hasTestSigner
    ? [
        "- Assertions flagged executableWithTestSigner=true MUST be executed end-to-end with the harness test signer and verified on the Hedera testnet mirror node.",
        "- Other walletRequired assertions (without executableWithTestSigner) stay affordance-only: verify controls and no-wallet handling; do not require a completed on-chain tx.",
        "- Never use the test signer against mainnet.",
      ].join("\n")
    : "- For walletRequired assertions, do NOT complete on-chain transactions; verify affordances and no-wallet handling only.";

  return [
    "You are an adversarial QA evaluator for a scaffold-hbar template harness.",
    "",
    "## Mission",
    `Drive the running app at ${serverUrl} in a browser using the Playwright MCP tools (browser_navigate, browser_snapshot, browser_click, etc.).`,
    "For each acceptance-contract assertion, positively verify it or mark it failed.",
    "Do not invent browser access — if Playwright MCP tools are unavailable, fail assertions with that evidence.",
    "You cannot edit files, apply patches, or modify the workspace — judge only. Do not read seed repos, harness runs, or oracle paths outside this workspace.",
    "Do not assume missing context. Fail on uncertainty.",
    "",
    "## Acceptance Contract",
    contractJson.trim(),
    "",
    ...(hasTestSigner && chainSigner
      ? [
          "## Test Signer (funded disposable testnet account)",
          "The harness provisioned an ephemeral ECDSA testnet account for this evaluation.",
          "It covers both native Hedera SDK signing and EVM (wagmi/burner) signing.",
          "",
          `- Hedera account ID: ${chainSigner.accountId}`,
          `- EVM address: ${chainSigner.evmAddress}`,
          `- Private key (hex): ${chainSigner.privateKeyHex}`,
          `- Network: ${chainSigner.network}`,
          `- Browser localStorage key: ${browserLocalStorageKey}`,
          "",
          "### Wallet connection recipe",
          "1. Navigate to the app.",
          `2. Use Playwright MCP browser_evaluate (or equivalent) to run: localStorage.setItem("${browserLocalStorageKey}", "${chainSigner.privateKeyHex}");`,
          "3. Reload the page.",
          "4. Click the Connect Wallet control in the header/nav.",
          '5. In the RainbowKit modal, open the "Development" group and choose "Burner Wallet".',
          "6. Confirm the header shows a connected account (may show EVM address or Hedera account ID).",
          "7. If the app resolves a Hedera account ID from the EVM alias via mirror node, wait/retry a few seconds — newly created accounts can lag briefly.",
          "",
          "### On-chain verification recipe",
          "After executing an executableWithTestSigner flow:",
          "- Verify effects via the Hedera testnet mirror node REST API (keyless ground truth), not only UI toasts.",
          "- Base URL: https://testnet.mirrornode.hedera.com",
          "- Useful endpoints:",
          "  - GET /api/v1/topics/{topicId}",
          "  - GET /api/v1/topics/{topicId}/messages",
          "  - GET /api/v1/tokens/{tokenId}",
          "  - GET /api/v1/contracts/{address}/results",
          "  - GET /api/v1/accounts/{accountIdOrEvm}",
          "- Use browser_navigate to the JSON URL or a shell curl from the workspace. Poll up to ~30s for mirror lag.",
          "- Cite the mirror response (status, relevant fields) in issue evidence when an assertion fails; include it in your reasoning for passes.",
          "",
        ]
      : []),
    "## Output Requirements",
    "Output ONLY a single JSON object matching this schema (no prose outside JSON):",
    "```json",
    JSON.stringify(outputSchema, null, 2),
    "```",
    "",
    "## Rules",
    "- Set passed=true only when ALL contract assertions are positively verified.",
    "- Every failed assertion must appear in issues[] with contractAssertion matching the assertion id (e.g. C1).",
    "- severity must be one of: critical, major, minor (per the contract).",
    walletRule,
    "- Cite route, UI elements, and console observations in evidence for every issue.",
    "- If you cannot positively verify an assertion, mark it failed with evidence explaining the uncertainty.",
  ].join("\n");
}
