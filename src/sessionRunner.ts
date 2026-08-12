import path from "node:path";
import { access } from "node:fs/promises";
import {
  appendHarnessLog,
  appendHarnessNote,
  writeStatusFile,
} from "./runArtifacts.js";
import { logPhase, runSessionAttemptLoop } from "./attemptLoop.js";
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
import {
  commitAttempt,
  resolveCurrentBranch,
  type CheckpointCommitResult,
} from "./harnessGit.js";
import {
  cleanupRuntimeInjections,
  type CleanupResult,
} from "./runCleanup.js";
import { formatRunOutro } from "./runOutro.js";
import {
  prepareSession,
  readSession,
  recordCheckpoint,
  resolveHeadShaOrThrow,
  updateSession,
  type SessionMetadata,
} from "./session.js";
import { HARNESS_CONTEXT_DIR, HARNESS_SKILLS_DIR } from "./runtimePaths.js";

export interface RunSessionOptions extends CliOptions {
  /** Test seam: skip host tool PATH checks. */
  skipToolChecks?: boolean;
  /** Test seam: skip host baseline commands. */
  skipBaseline?: boolean;
}

export interface SessionRunResult {
  report: RunReport;
  session: SessionMetadata;
  cleanup: CleanupResult;
  outroLines: string[];
}

/**
 * Project-centric in-place entrypoint for `run`:
 * uses cwd as the workspace and stores artifacts under `.harness/runs/<id>/`.
 *
 * Git/session orchestration owns branch creation, continuation, and dirty recovery.
 * Completion cleans runtime injections and prints push/PR/continue instructions
 * without executing them, switching branches, merging, or pushing.
 */
export async function runSession(options: RunSessionOptions): Promise<SessionRunResult> {
  const workspacePath = path.resolve(options.workspacePath ?? process.cwd());
  await access(workspacePath);

  const loaded = await loadTemplateSpec(options.specPath);
  const { spec, projectRoot } = loaded;
  const maxAttempts = options.maxAttempts ?? spec.maxAttempts;

  logPhase("Preparing harness session", `${spec.name} @ ${workspacePath}`);
  const prepared = await prepareSession({
    workspacePath,
    loaded,
    skipToolChecks: options.skipToolChecks,
    skipBaseline: options.skipBaseline,
    forceNew: options.forceNew,
    continueBranch: options.continueBranch,
  });

  const { layout, session, mode } = prepared;
  const isContinue = mode === "continue";
  const cycle = prepared.cycle;
  const startingAttempt = prepared.startingAttempt;
  const startedAt = new Date();
  let chainSigner: ChainSigner | undefined;
  let report: RunReport | undefined;
  let cleanup: CleanupResult | undefined;

  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  logPhase(
    isContinue ? "Run continued" : "Run started",
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
      ? `Run continued: ${spec.name} (cycle ${cycle})`
      : `Run started: ${spec.name}`,
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

  const workspaceRoot = layout.workspacePath;
  logPhase("Using in-place workspace", workspaceRoot);

  try {
    const resolvedSkillPaths = await resolveSkillPaths(spec.skills ?? [], projectRoot);
    const vendoredSkills = await vendorSkills(workspaceRoot, resolvedSkillPaths, {
      skillsDir: HARNESS_SKILLS_DIR,
    });
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "skills_vendored",
      timestamp: new Date().toISOString(),
      count: vendoredSkills.length,
      workspaceSkillsDir: path.join(workspaceRoot, HARNESS_SKILLS_DIR),
    });
    logPhase(
      "Skills vendored into ignored runtime",
      `${HARNESS_SKILLS_DIR} (${vendoredSkills.length} files)`,
    );

    // Context under .harness/runtime/; do not permanently mutate tracked .cursor/mcp.json.
    const vendoredContext = await vendorHarnessContext(
      workspaceRoot,
      {
        prdPath: spec.prdPaths[0],
        contractPath: spec.contractPath,
      },
      {
        contextDir: HARNESS_CONTEXT_DIR,
        injectPlaywrightMcp: false,
      },
    );
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "context_vendored",
      timestamp: new Date().toISOString(),
      prdPath: vendoredContext.prdRelativePath,
      contractPath: vendoredContext.contractRelativePath,
      workspaceContextDir: path.join(workspaceRoot, HARNESS_CONTEXT_DIR),
    });
    logPhase(
      "Harness context vendored into ignored runtime",
      `${HARNESS_CONTEXT_DIR}${vendoredContext.contractRelativePath ? " (prd + contract)" : " (prd)"}`,
    );

    if (spec.chainValidation?.enabled) {
      const provisioned = await provisionChainSigner(spec.chainValidation, layout.runDirectory, {
        projectRoot: layout.workspacePath,
        packageManager: spec.constraints?.packageManager,
      });
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

    report = await runSessionAttemptLoop({
      layout,
      spec,
      specPath: loaded.specPath,

      maxAttempts,
      isContinue,
      cycle,
      startingAttempt,
      startedAt,
      workspacePath: workspaceRoot,
      vendoredSkills,
      vendoredContext,
      chainSigner,
      previousOpenFindingIds: session.openFindingIds,
      commitAttempt: async (workspace, attempt, passed, findings) => {
        const commit: CheckpointCommitResult = await commitAttempt(
          workspace,
          attempt,
          passed,
          findings,
        );
        const checkpointSha = commit.commitSha ?? (await resolveHeadShaOrThrow(workspace));
        await recordCheckpoint({
          runDirectory: layout.runDirectory,
          attempt,
          checkpointSha,
          gateStatus: passed ? "passed" : "failed",
        });
        if (commit.skippedSecrets.length > 0) {
          await appendHarnessNote(
            layout.notesLogPath,
            `Attempt ${attempt} checkpoint skipped secrets`,
            commit.skippedSecrets.map(filePath => `- ${filePath}`).join("\n"),
          );
        }
        return commit;
      },
    });

    await updateSession(layout.runDirectory, {
      lastAttempt: report.attempts,
      lastCheckpointSha: await resolveHeadShaOrThrow(layout.workspacePath),
      cycle: report.cycle ?? session.cycle,
      openFindingIds: report.openFindingIds,
      gateStatus: report.passed
        ? "passed"
        : report.semanticValidation?.infrastructureFailure
          ? "aborted"
          : "failed",
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

    cleanup = await cleanupRuntimeInjections(layout.workspacePath);
    logPhase(
      "Run runtime cleaned",
      cleanup.removedPaths.length > 0
        ? cleanup.removedPaths.join(", ")
        : "(nothing removable left)",
    );
    await appendHarnessNote(
      layout.notesLogPath,
      "Run runtime cleanup",
      [
        `removed=${cleanup.removedPaths.join(", ") || "(none)"}`,
        `mcpStripped=${cleanup.mcpStripped}`,
        `treeClean=${cleanup.treeClean}`,
        cleanup.consumerDirtyPaths.length > 0
          ? `dirty=\n${cleanup.consumerDirtyPaths.map(filePath => `  - ${filePath}`).join("\n")}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    );

    await writeStatusFile(layout.runDirectory, {
      phase: "cleanup_complete",
      branch: session.branch,
      baseBranch: session.baseBranch,
      treeClean: cleanup.treeClean,
      removedPaths: cleanup.removedPaths,
      mcpStripped: cleanup.mcpStripped,
    });
  }

  if (!report || !cleanup) {
    throw new Error("Run finished without a report (internal error).");
  }

  const currentBranch = await resolveCurrentBranch(layout.workspacePath);
  if (currentBranch !== session.branch) {
    throw new Error(
      [
        "Run completion safety check failed: branch changed unexpectedly.",
        `expected=${session.branch}`,
        `actual=${currentBranch ?? "(detached)"}`,
      ].join("\n"),
    );
  }

  const persistedSession = await readSession(layout.runDirectory);
  const finalSession: SessionMetadata = persistedSession ?? {
    ...session,
    lastAttempt: report.attempts,
    gateStatus: report.passed
      ? "passed"
      : report.semanticValidation?.infrastructureFailure
        ? "aborted"
        : "failed",
  };

  const outroLines = formatRunOutro({
    report,
    session: finalSession,
    cleanup,
    specPath: loaded.specPath,
  });

  await appendHarnessNote(layout.notesLogPath, "Run outro", outroLines.join("\n"));
  logPhase(`Run ${report.passed ? "passed" : "failed"}`, session.branch);

  return {
    report,
    session: finalSession,
    cleanup,
    outroLines,
  };
}
