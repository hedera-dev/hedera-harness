import { readFile } from "node:fs/promises";
import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { buildValidatorPrompt } from "./promptBuilder.js";
import { writePromptFile } from "./runArtifacts.js";
import type {
  ChainSigner,
  SemanticValidationResult,
  TemplateSpec,
  ValidationFinding,
  ValidatorIssue,
  ValidatorVerdict,
} from "./types.js";
import { parseValidatorVerdict } from "./validatorVerdictParser.js";
import { annotateInfrastructureFailure } from "./semanticInfra.js";
import type { DevServerSession } from "./validation/devServer.js";

export function isValidatorEnabled(spec: TemplateSpec): boolean {
  return spec.validator !== undefined && spec.validator.enabled !== false;
}

export async function runSemanticValidation(input: {
  workspacePath: string;
  spec: TemplateSpec;
  attempt: number;
  logsDirectory: string;
  promptsDirectory: string;
  /** Required — callers own lifecycle via createDevServerSession. */
  devServer: DevServerSession;
  chainSigner?: ChainSigner;
  /** Override vendored contract path (`.harness/runtime/context/...`). */
  contractRelativePath?: string;
  /** Appended to the validator invocation — e.g. --mcp-config for CLIs that take one. */
  extraArgs?: string[];
}): Promise<SemanticValidationResult> {
  const startedAt = Date.now();
  const validatorConfig = input.spec.validator;
  if (!validatorConfig || validatorConfig.enabled === false) {
    return {
      passed: true,
      findings: [],
      durationMs: 0,
    };
  }

  if (!input.spec.contractPath) {
    return annotateInfrastructureFailure(
      failureResult(startedAt, [
        findingFromMessage("validator-config", "Semantic validator requires spec.contract to be configured."),
      ]),
    );
  }

  if (!input.spec.validators.playwrightPath) {
    return annotateInfrastructureFailure(
      failureResult(startedAt, [
        findingFromMessage(
          "validator-config",
          "Semantic validator requires validators.playwright so the harness can start the dev server.",
        ),
      ]),
    );
  }

  const contractRelativePath =
    input.contractRelativePath ?? path.posix.join(".harness-context", "acceptance-contract.json");
  const contractPath = path.join(input.workspacePath, ...contractRelativePath.split("/"));
  const contract = await readFile(contractPath, "utf8");
  const serverUrl = input.devServer.url;

  try {
    const browserKey =
      input.spec.chainValidation?.expose.browserLocalStorageKey ?? "burnerWallet.pk";
    const prompt = await buildValidatorPrompt(
      input.spec,
      contract,
      serverUrl,
      input.chainSigner,
      browserKey,
    );
    const promptPath = path.join(input.promptsDirectory, `validator-attempt-${input.attempt}.txt`);
    const agentLogPath = path.join(input.logsDirectory, `validator-attempt-${input.attempt}.log`);
    const agentActivityLogPath = path.join(
      input.logsDirectory,
      `validator-attempt-${input.attempt}.activity.log`,
    );

    await writePromptFile(promptPath, prompt, [input.chainSigner?.privateKeyHex]);

    const validator = new CommandAgentProvider(
      input.extraArgs?.length
        ? { ...validatorConfig, args: [...(validatorConfig.args ?? []), ...input.extraArgs] }
        : validatorConfig,
    );
    const agentResult = await validator.run({
      workspacePath: input.workspacePath,
      prompt,
      attempt: input.attempt,
      timeoutMs: validatorConfig.timeoutMs,
      logPath: agentLogPath,
      activityLogPath: agentActivityLogPath,
    });

    if (agentResult.exitCode !== 0) {
      return annotateInfrastructureFailure(
        failureResult(
          startedAt,
          [
            findingFromMessage(
              `validator-exit:${input.attempt}`,
              agentResult.timedOut
                ? `Validator agent timed out after ${Math.round(agentResult.durationMs / 1000)}s`
                : `Validator agent exited with code ${agentResult.exitCode ?? "null"}`,
              agentResult.stderr || agentResult.stdout,
            ),
          ],
          serverUrl,
        ),
      );
    }

    const verdict = parseValidatorVerdict(agentResult.stdout);
    if (!verdict) {
      return annotateInfrastructureFailure(
        failureResult(
          startedAt,
          [
            findingFromMessage(
              "validator-output-unparseable",
              "Validator agent did not return a parseable JSON verdict.",
              truncate(agentResult.stdout),
            ),
          ],
          serverUrl,
        ),
      );
    }

    const findings = mapVerdictToFindings(verdict);
    return annotateInfrastructureFailure({
      passed: verdict.passed && verdict.issues.length === 0 && findings.length === 0,
      verdict,
      findings,
      serverUrl,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return annotateInfrastructureFailure(
      failureResult(startedAt, [findingFromMessage("validator-runtime", message)], serverUrl),
    );
  }
}

function mapVerdictToFindings(verdict: ValidatorVerdict): ValidationFinding[] {
  const findings = verdict.issues.map(issue => mapIssueToFinding(issue));

  if (!verdict.passed && findings.length === 0) {
    return [
      findingFromMessage(
        "validator-empty-issues",
        "Validator reported failure without listing issues.",
        verdict.summary,
      ),
    ];
  }

  if (verdict.passed && findings.length > 0) {
    return [
      findingFromMessage(
        "validator-inconsistent",
        "Validator reported pass=true but listed issues.",
        verdict.summary,
      ),
      ...findings,
    ];
  }

  return findings;
}

function mapIssueToFinding(issue: ValidatorIssue): ValidationFinding {
  const assertion = issue.contractAssertion ? ` [${issue.contractAssertion}]` : "";
  const route = issue.route ? ` (${issue.route})` : "";
  return {
    id: `semantic:${issue.id}`,
    category: "semantic",
    message: `${issue.severity}${assertion}${route}: ${issue.message}`,
    details: issue.evidence,
    contractAssertion: issue.contractAssertion,
    route: issue.route,
  };
}

function failureResult(
  startedAt: number,
  findings: ValidationFinding[],
  serverUrl?: string,
): SemanticValidationResult {
  return {
    passed: false,
    findings,
    serverUrl,
    durationMs: Date.now() - startedAt,
  };
}

function findingFromMessage(id: string, message: string, details?: string): ValidationFinding {
  return {
    id,
    category: "semantic",
    message,
    details: details ? truncate(details) : undefined,
  };
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
