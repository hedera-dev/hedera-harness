import path from "node:path";
import { access } from "node:fs/promises";
import {
  appendHarnessLog,
  appendHarnessNote,
  writeStatusFile,
} from "./runArtifacts.js";
import { logPhase, runAttemptLoop } from "./attemptLoop.js";
import { loadTemplateSpec } from "./specLoader.js";
import type { ChainSigner, CliOptions, RunReport } from "./types.js";
import { vendorHarnessContext } from "./contextVendor.js";
import { resolveSkillPaths } from "./skillResolver.js";
import { vendorSkills } from "./skillVendor.js";
import {
  assertChainValidationOperatorEnv,
  provisionChainSigner,
  sweepChainSigner,
} from "./validation/chainSigner.js";
import { commitExtendAttempt } from "./extendGit.js";
import {
  prepareExtendSession,
  recordExtendCheckpoint,
  resolveHeadShaOrThrow,
  updateExtendSession,
} from "./extendSession.js";
import { EXTEND_CONTEXT_DIR, EXTEND_SKILLS_DIR } from "./runtimePaths.js";

export interface RunExtendOptions extends CliOptions {
  /** Test seam: skip host tool PATH checks. */
  skipToolChecks?: boolean;
  /** Test seam: skip extend.baseline commands. */
  skipBaseline?: boolean;
}

/**
 * In-place extend entrypoint: skips `seedWorkspace`, uses cwd as the workspace,
 * and stores harness runtime artifacts under `.harness/runs/<id>/`.
 *
 * Git/session orchestration owns branch creation, continuation, and dirty recovery.
 */
export async function runExtend(options: RunExtendOptions): Promise<RunReport> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  const loaded = await loadTemplateSpec(options.specPath, { requireSeed: false });
  const { spec, projectRoot } = loaded;
  const maxAttempts = options.maxAttempts ?? spec.maxAttempts;

  const prepared = await prepareExtendSession({
    workspacePath,
    loaded,
    skipToolChecks: options.skipToolChecks,
    skipBaseline: options.skipBaseline,
  });

  const { layout, session, mode } = prepared;
  const isContinue = mode === "continue";
  const cycle = prepared.cycle;
  const startingAttempt = prepared.startingAttempt;
  const startedAt = new Date();
  let chainSigner: ChainSigner | undefined;

  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  logPhase(
    isContinue ? "Extend continued" : "Extend started",
    `${layout.runDirectory} (${session.branch})`,
  );
  await writeStatusFile(layout.runDirectory, {
    phase: isContinue ? "continued" : "started",
    specName: spec.name,
    runDirectory: layout.runDirectory,
    layoutMode: layout.mode,
    workspacePath: layout.workspacePath,
    branch: session.branch,
    baseBranch: session.baseBranch,
    sessionId: session.sessionId,
    startingAttempt,
    maxAttemptsThisCycle: maxAttempts,
    cycle,
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
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "cycle_started",
      timestamp: new Date().toISOString(),
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
    isContinue
      ? `Extend continued: ${spec.name} (cycle ${cycle})`
      : `Extend started: ${spec.name}`,
    [
      `Branch: ${session.branch}`,
      `Base: ${session.baseBranch} @ ${session.baseSha.slice(0, 8)}`,
      `Run directory: ${layout.runDirectory}`,
      `Workspace: ${layout.workspacePath}`,
      `Spec: ${loaded.specPath}`,
      `Layout: ${layout.mode}`,
      session.baselineResult
        ? `Baseline: ${session.baselineResult.passed ? "passed" : "failed"} (${session.baselineResult.commands.length} command(s))`
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
  );

  const seedResult = {
    workspacePath: layout.workspacePath,
    repo: "local-workspace",
    ref: session.branch,
    commitSha: session.lastCheckpointSha,
  };
  logPhase("Using in-place workspace (no seed clone)", seedResult.workspacePath);

  const resolvedSkillPaths = await resolveSkillPaths(spec.skills ?? [], projectRoot);
  const vendoredSkills = await vendorSkills(seedResult.workspacePath, resolvedSkillPaths, {
    skillsDir: EXTEND_SKILLS_DIR,
  });
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "skills_vendored",
    timestamp: new Date().toISOString(),
    count: vendoredSkills.length,
    workspaceSkillsDir: path.join(seedResult.workspacePath, EXTEND_SKILLS_DIR),
  });
  logPhase(
    "Skills vendored into ignored runtime",
    `${EXTEND_SKILLS_DIR} (${vendoredSkills.length} files)`,
  );

  // Context under .harness/runtime/; do not permanently mutate tracked .cursor/mcp.json.
  const vendoredContext = await vendorHarnessContext(
    seedResult.workspacePath,
    {
      prdPath: spec.prdPath,
      contractPath: spec.contractPath,
    },
    {
      contextDir: EXTEND_CONTEXT_DIR,
      injectPlaywrightMcp: false,
    },
  );
  await appendHarnessLog(layout.jsonlLogPath, {
    type: "context_vendored",
    timestamp: new Date().toISOString(),
    prdPath: vendoredContext.prdRelativePath,
    contractPath: vendoredContext.contractRelativePath,
    workspaceContextDir: path.join(seedResult.workspacePath, EXTEND_CONTEXT_DIR),
  });
  logPhase(
    "Harness context vendored into ignored runtime",
    `${EXTEND_CONTEXT_DIR}${vendoredContext.contractRelativePath ? " (prd + contract)" : " (prd)"}`,
  );

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
    const report = await runAttemptLoop({
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
      commitAttempt: async (workspace, attempt, passed, findingCount) => {
        const commit = await commitExtendAttempt(workspace, attempt, passed, findingCount);
        const checkpointSha = commit.commitSha ?? (await resolveHeadShaOrThrow(workspace));
        await recordExtendCheckpoint({
          runDirectory: layout.runDirectory,
          attempt,
          checkpointSha,
          gateStatus: passed ? "passed" : "failed",
        });
        return commit;
      },
    });

    await updateExtendSession(layout.runDirectory, {
      lastAttempt: report.attempts,
      lastCheckpointSha: await resolveHeadShaOrThrow(layout.workspacePath),
      cycle: report.cycle ?? session.cycle,
      gateStatus: report.passed
        ? "passed"
        : report.semanticValidation?.infrastructureFailure
          ? "aborted"
          : "failed",
    });

    return report;
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
