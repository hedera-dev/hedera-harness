import { readFile } from "node:fs/promises";
import path from "node:path";
import { CommandAgentProvider } from "./providers/commandAgentProvider.js";
import { buildValidatorPrompt } from "./promptBuilder.js";
import { writePromptFile } from "./runArtifacts.js";
import type {
  ChainSigner,
  EvaluationResult,
  TemplateSpec,
  ValidationFinding,
  ValidatorIssue,
  ValidatorVerdict,
} from "./types.js";
import { parseValidatorVerdict } from "./validatorVerdictParser.js";
import { annotateInfrastructureFailure } from "./evalInfra.js";
import { specHasEval } from "./sliceSelection.js";
import type { DevServerSession } from "./validation/devServer.js";

export function isValidatorEnabled(spec: TemplateSpec): boolean {
  return spec.validator !== undefined && spec.validator.enabled !== false;
}

export async function runEvaluation(input: {
  workspacePath: string;
  spec: TemplateSpec;
  attempt: number;
  logsDirectory: string;
  promptsDirectory: string;
  /** Required — callers own lifecycle via createDevServerSession. */
  devServer: DevServerSession;
  chainSigner?: ChainSigner;
  /** Override vendored eval path (`.harness/runtime/context/...`). */
  evalRelativePath?: string;
  /** Appended to the validator invocation — e.g. --mcp-config for CLIs that take one. */
  extraArgs?: string[];
}): Promise<EvaluationResult> {
  const startedAt = Date.now();
  const validatorConfig = input.spec.validator;
  if (!validatorConfig || validatorConfig.enabled === false) {
    return {
      passed: true,
      findings: [],
      durationMs: 0,
    };
  }

  if (!specHasEval(input.spec)) {
    return annotateInfrastructureFailure(
      failureResult(startedAt, [
        findingFromMessage("validator-config", "Evaluator requires spec.eval to be configured."),
      ]),
    );
  }

  if (!input.spec.validators.playwrightPath) {
    return annotateInfrastructureFailure(
      failureResult(startedAt, [
        findingFromMessage(
          "validator-config",
          "Evaluator requires validators.playwright so the harness can start the dev server.",
        ),
      ]),
    );
  }

  const evalRelativePath =
    input.evalRelativePath ?? path.posix.join(".harness-context", "eval.json");
  const evalPath = path.join(input.workspacePath, ...evalRelativePath.split("/"));
  const evalContent = await readFile(evalPath, "utf8");
  const serverUrl = input.devServer.url;

  try {
    const browserKey =
      input.spec.chainValidation?.expose.browserLocalStorageKey ?? "burnerWallet.pk";
    const prompt = await buildValidatorPrompt(
      input.spec,
      evalContent,
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
  const assertion = issue.assertion ? ` [${issue.assertion}]` : "";
  const route = issue.route ? ` (${issue.route})` : "";
  return {
    id: `eval:${issue.id}`,
    category: "eval",
    message: `${issue.severity}${assertion}${route}: ${issue.message}`,
    details: issue.evidence,
    assertion: issue.assertion,
    route: issue.route,
  };
}

function failureResult(
  startedAt: number,
  findings: ValidationFinding[],
  serverUrl?: string,
): EvaluationResult {
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
    category: "eval",
    message,
    details: details ? truncate(details) : undefined,
  };
}

function truncate(value: string, maxLength = 1200): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
