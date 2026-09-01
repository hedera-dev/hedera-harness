import { readFile } from "node:fs/promises";
import type { ChainSigner, TemplateSpec, ValidationFinding } from "./types.js";
import {
  VENDORED_EVAL_PATH,
  VENDORED_PRD_PATH,
  type VendoredContext,
} from "./contextVendor.js";
import type { VendoredSkill } from "./skillProvider.js";
import { HARNESS_CONTEXT_DIR, HARNESS_SKILLS_DIR } from "./runtimePaths.js";
import { renderPrompt } from "./promptTemplates.js";
import type { SliceContext } from "./attemptLoop.js";
import { selectActiveSlice } from "./sliceSelection.js";

/** Assembles prompt inputs; wording lives in `prompts/*.md`. */
export type RepairScope = "eval-scoped" | "runtime" | "broad";

interface EvalAssertion {
  id: string;
  journey?: string;
  route?: string;
  severity?: string;
  statement?: string;
  howToVerify?: string;
  walletRequired?: boolean;
}

const ASSERTION_ID_PATTERN = /\b(E\d+)\b/i;

interface ContextPaths {
  prdPath: string;
  evalPath: string;
  skillsRoot: string;
}

function runtimeContextPaths(
  vendoredSkills: VendoredSkill[],
  vendoredContext?: VendoredContext,
): ContextPaths {
  return {
    prdPath: vendoredContext?.prdRelativePath ?? `${HARNESS_CONTEXT_DIR}/prd.md`,
    evalPath:
      vendoredContext?.evalRelativePath ?? `${HARNESS_CONTEXT_DIR}/eval.json`,
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
  slice?: SliceContext,
): Promise<string> {
  const active = selectActiveSlice(spec, slice?.index ?? 0);
  const prd = await readFile(active.prdPath, "utf8");
  const paths = runtimeContextPaths(vendoredSkills, vendoredContext);
  const hasEval = Boolean(vendoredContext?.evalRelativePath ?? active.evalPath);

  return renderPrompt(spec.projectRoot, "generator", {
    attempt: String(attempt),
    prd: prd.trim(),
    ...sliceVars(slice),
    ...paths,
    hasEval,
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
  slice?: SliceContext,
): Promise<string> {
  const active = selectActiveSlice(spec, slice?.index ?? 0);
  const paths = runtimeContextPaths(vendoredSkills, vendoredContext);
  const hasEval = Boolean(vendoredContext?.evalRelativePath ?? active.evalPath);

  return renderPrompt(spec.projectRoot, "generator-continue", {
    cycle: String(cycle),
    ...sliceVars(slice),
    ...paths,
    hasEval,
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
 * - eval-scoped: only evaluate-checklist assertion gaps (ASSERT/SMOKE already green)
 * - runtime: yarn/playwright failures
 * - broad: structural/static/mixed failures
 */
export async function buildRepairPrompt(
  spec: TemplateSpec,
  findings: ValidationFinding[],
  attempt: number,
  vendoredContext?: VendoredContext,
): Promise<string> {
  const actionable = findings.filter(finding => finding.category !== "eval-infra");
  const scope = classifyRepairScope(actionable);
  const evalPath = vendoredContext?.evalRelativePath ?? VENDORED_EVAL_PATH;
  const prdPath = vendoredContext?.prdRelativePath ?? VENDORED_PRD_PATH;
  const fallbackActive = selectActiveSlice(spec, Math.max(0, spec.prdPaths.length - 1));
  const assertions = await loadEvalAssertions(
    vendoredContext?.evalSourcePath ?? fallbackActive.evalPath,
  );

  const hasEvalFindings = actionable.some(finding => finding.category === "eval");
  const hasEval = Boolean(vendoredContext?.evalRelativePath ?? fallbackActive.evalPath);
  const shared = {
    attempt: String(attempt),
    prdPath,
    evalPath,
    hardConstraints: formatHardConstraints(spec),
    findingsList: formatFindingsList(actionable),
    hasEvalFindings,
    evalTargets: formatEvalTargets(actionable, assertions),
    hasEval,
    hasMetadata: Boolean(
      spec.templateMetadata?.name ??
        spec.templateMetadata?.frontend ??
        spec.templateMetadata?.solidityFramework,
    ),
    metadata: formatMetadata(spec),
    hasRequiredFiles: spec.requiredFiles.length > 0,
    requiredFiles: formatBulletList(spec.requiredFiles),
  };

  if (scope === "eval-scoped") {
    return renderPrompt(spec.projectRoot, "repair-eval", shared);
  }
  if (scope === "runtime") {
    return renderPrompt(spec.projectRoot, "repair-runtime", {
      ...shared,
      hasEvalChecklist: hasEvalFindings && hasEval,
    });
  }
  return renderPrompt(spec.projectRoot, "repair-broad", shared);
}

export function classifyRepairScope(findings: ValidationFinding[]): RepairScope {
  const actionable = findings.filter(finding => finding.category !== "eval-infra");
  if (actionable.length === 0) {
    return "broad";
  }

  const categories = new Set(actionable.map(finding => finding.category));
  const onlyEval = [...categories].every(category => category === "eval");
  if (onlyEval) {
    return "eval-scoped";
  }

  const hasStructural = [...categories].some(category =>
    ["files", "static", "secret", "agent"].includes(category),
  );
  if (
    !hasStructural &&
    [...categories].every(category => ["commands", "playwright", "eval"].includes(category))
  ) {
    if (categories.has("commands") || categories.has("playwright")) {
      return "runtime";
    }
  }

  return "broad";
}

export function extractAssertionId(finding: ValidationFinding): string | undefined {
  if (finding.assertion) {
    return finding.assertion.toUpperCase();
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
  evalJson: string,
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
        assertion: "E1",
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
    eval: evalJson.trim(),
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

/** Slice framing. A single-increment run renders none of it. */
function sliceVars(slice?: SliceContext): Record<string, string | boolean> {
  if (!slice || slice.count <= 1) {
    return { hasSlices: false, hasCompletedSlices: false };
  }
  return {
    hasSlices: true,
    sliceNumber: String(slice.index + 1),
    sliceCount: String(slice.count),
    hasCompletedSlices: slice.index > 0,
    completedSlices: String(slice.index),
  };
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

function formatEvalTargets(
  findings: ValidationFinding[],
  assertions: Map<string, EvalAssertion>,
): string {
  const evalFindings = findings.filter(finding => finding.category === "eval");
  if (evalFindings.length === 0) {
    return "- (no evaluate findings)";
  }

  return evalFindings
    .map(finding => {
      const assertionId = extractAssertionId(finding);
      const fromChecklist = assertionId ? assertions.get(assertionId) : undefined;
      const route = finding.route ?? fromChecklist?.route;
      return [
        `### ${assertionId ?? finding.id}`,
        route ? `- route: \`${route}\`` : undefined,
        fromChecklist?.severity ? `- severity: ${fromChecklist.severity}` : undefined,
        fromChecklist?.journey ? `- journey: ${fromChecklist.journey}` : undefined,
        fromChecklist?.statement ? `- statement: ${fromChecklist.statement}` : undefined,
        fromChecklist?.howToVerify ? `- howToVerify: ${fromChecklist.howToVerify}` : undefined,
        `- validator message: ${finding.message}`,
        finding.details ? `- evidence: ${finding.details}` : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    })
    .join("\n\n");
}

async function loadEvalAssertions(
  evalPath?: string,
): Promise<Map<string, EvalAssertion>> {
  const map = new Map<string, EvalAssertion>();
  if (!evalPath) {
    return map;
  }

  try {
    const raw = await readFile(evalPath, "utf8");
    const parsed = JSON.parse(raw) as { assertions?: EvalAssertion[] };
    for (const assertion of parsed.assertions ?? []) {
      if (assertion?.id) {
        map.set(assertion.id.toUpperCase(), assertion);
      }
    }
  } catch {
    // Eval checklist missing/unreadable — repair still works with finding text only.
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
