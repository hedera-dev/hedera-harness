import path from "node:path";
import { access } from "node:fs/promises";
import {
  appendHarnessLog,
  appendHarnessNote,
  createExtendLayout,
  lastAttemptNumber,
  nextCycleNumber,
  openRunLayout,
  writeStatusFile,
} from "./runArtifacts.js";
import { logPhase, runAttemptLoop } from "./attemptLoop.js";
import { loadTemplateSpec } from "./specLoader.js";
import type { ChainSigner, CliOptions, RunReport } from "./types.js";
import { vendorHarnessContext } from "./contextVendor.js";
import { resolveSkillPaths } from "./skillResolver.js";
import { vendorSkills } from "./skillVendor.js";
import type { WorkspaceGitCommitResult } from "./workspaceGit.js";
import { executeCommand } from "./command.js";
import {
  assertChainValidationOperatorEnv,
  provisionChainSigner,
  sweepChainSigner,
} from "./validation/chainSigner.js";

/**
 * In-place extend entrypoint: skips `seedWorkspace`, uses cwd as the workspace,
 * and stores harness runtime artifacts under `.harness/runs/<id>/`.
 *
 * Git/session orchestration (branch creation, checkpoint policy) is layered on
 * by later extend modules; attempt commits are no-ops here until then.
 */
export async function runExtend(options: CliOptions): Promise<RunReport> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  const loaded = await loadTemplateSpec(options.specPath);
  const { spec, projectRoot } = loaded;
  const maxAttempts = options.maxAttempts ?? spec.maxAttempts;
  const continueRunDirectory = options.continueRunDirectory
    ? path.resolve(options.continueRunDirectory)
    : undefined;
  const isContinue = Boolean(continueRunDirectory);

  const layout = isContinue
    ? await openRunLayout(continueRunDirectory!, spec.logging)
    : await createExtendLayout(workspacePath, spec.name, spec.logging);

  if (layout.mode !== "in-place-extend") {
    throw new Error(
      `Expected in-place-extend layout for extend, got ${layout.mode} at ${layout.runDirectory}`,
    );
  }
  if (path.resolve(layout.workspacePath) !== workspacePath && !isContinue) {
    throw new Error(
      `Extend layout workspace mismatch: expected ${workspacePath}, got ${layout.workspacePath}`,
    );
  }

  const startedAt = new Date();
  const cycle = isContinue ? await nextCycleNumber(layout.reportsDirectory) : undefined;
  const startingAttempt = isContinue ? (await lastAttemptNumber(layout.logsDirectory)) + 1 : 1;
  let chainSigner: ChainSigner | undefined;

  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  logPhase(isContinue ? "Extend continued" : "Extend started", layout.runDirectory);
  await writeStatusFile(layout.runDirectory, {
    phase: isContinue ? "continued" : "started",
    specName: spec.name,
    runDirectory: layout.runDirectory,
    layoutMode: layout.mode,
    workspacePath: layout.workspacePath,
    startingAttempt,
    maxAttemptsThisCycle: maxAttempts,
  });

  if (isContinue) {
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "run_continued",
      timestamp: startedAt.toISOString(),
      specName: spec.name,
      runDirectory: layout.runDirectory,
      cycle: cycle!,
      startingAttempt,
      maxAttemptsThisCycle: maxAttempts,
    });
  } else {
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "run_started",
      timestamp: startedAt.toISOString(),
      specName: spec.name,
      runDirectory: layout.runDirectory,
    });
  }
  await appendHarnessNote(
    layout.notesLogPath,
    isContinue ? `Extend continued: ${spec.name} (cycle ${cycle})` : `Extend started: ${spec.name}`,
    [
      `Run directory: ${layout.runDirectory}`,
      `Workspace: ${layout.workspacePath}`,
      `Spec: ${loaded.specPath}`,
      `Layout: ${layout.mode}`,
    ].join("\n"),
  );

  const seedResult = {
    workspacePath: layout.workspacePath,
    repo: "local-workspace",
    ref: "HEAD",
    commitSha: await resolveWorkspaceHeadSha(layout.workspacePath),
  };
  logPhase("Using in-place workspace (no seed clone)", seedResult.workspacePath);

  const resolvedSkillPaths = await resolveSkillPaths(spec.skills ?? [], projectRoot);
  const vendoredSkills = await vendorSkills(seedResult.workspacePath, resolvedSkillPaths);
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "skills_vendored",
    timestamp: new Date().toISOString(),
    count: vendoredSkills.length,
    workspaceSkillsDir: path.join(seedResult.workspacePath, ".harness-skills"),
  });
  logPhase("Skills vendored into workspace", `.harness-skills (${vendoredSkills.length} files)`);

  const vendoredContext = await vendorHarnessContext(seedResult.workspacePath, {
    prdPath: spec.prdPath,
    contractPath: spec.contractPath,
  });
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "context_vendored",
    timestamp: new Date().toISOString(),
    prdPath: vendoredContext.prdRelativePath,
    contractPath: vendoredContext.contractRelativePath,
    workspaceContextDir: path.join(seedResult.workspacePath, ".harness-context"),
  });
  logPhase(
    "Harness context vendored into workspace",
    `.harness-context${vendoredContext.contractRelativePath ? " (prd + contract)" : " (prd)"}${vendoredContext.playwrightMcpPath ? " + playwright MCP" : ""}`,
  );

  // Never auto-init git in the consumer repo; extend preflight/session code owns that.
  if (seedResult.commitSha !== "unknown") {
    logPhase("Workspace git present", seedResult.commitSha.slice(0, 8));
  }

  if (spec.chainValidation?.enabled) {
    const provisioned = await provisionChainSigner(spec.chainValidation, layout.runDirectory);
    chainSigner = provisioned.signer;
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "chain_signer_provisioned",
      timestamp: new Date().toISOString(),
      accountId: chainSigner.accountId,
      evmAddress: chainSigner.evmAddress,
      network: chainSigner.network,
      reused: provisioned.reused,
      ...(provisioned.toppedUpHbar !== undefined ? { toppedUpHbar: provisioned.toppedUpHbar } : {}),
      ...(provisioned.replacedDeleted ? { replacedDeleted: true } : {}),
    });
    logPhase(
      provisioned.reused ? "Chain signer reused" : "Chain signer provisioned",
      `${chainSigner.accountId} (${chainSigner.evmAddress})`,
    );
  }

  try {
    return await runAttemptLoop({
      layout,
      spec,
      specPath: loaded.specPath,
      projectRoot,
      maxAttempts,
      isContinue,
      cycle,
      startingAttempt,
      startedAt,
      seedResult,
      vendoredSkills,
      vendoredContext,
      chainSigner,
      // Extend checkpoint commits are handled by extendGit (later); do not
      // `git add -A` the consumer repository from the isolated-run helper.
      commitAttempt: async (_workspace, attempt, passed, findingCount) =>
        noopExtendCommit(attempt, passed, findingCount),
    });
  } finally {
    if (chainSigner && spec.chainValidation?.enabled) {
      const sweep = await sweepChainSigner(chainSigner, spec.chainValidation, layout.runDirectory);
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "chain_signer_swept",
        timestamp: new Date().toISOString(),
        accountId: chainSigner.accountId,
        success: sweep.success,
        error: sweep.error,
      });
      if (sweep.success) {
        logPhase("Chain signer swept", chainSigner.accountId);
      } else {
        logPhase("Chain signer sweep failed (best-effort)", sweep.error);
      }
    }
  }
}

async function resolveWorkspaceHeadSha(workspacePath: string): Promise<string> {
  const result = await executeCommand({
    command: "git",
    args: ["rev-parse", "HEAD"],
    cwd: workspacePath,
  });
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  return "unknown";
}

async function noopExtendCommit(
  attempt: number,
  passed: boolean,
  findingCount: number,
): Promise<WorkspaceGitCommitResult> {
  return {
    committed: false,
    message: `harness: extension attempt ${attempt} ${passed ? "passed" : "failed"} (${findingCount} finding(s))`,
  };
}
