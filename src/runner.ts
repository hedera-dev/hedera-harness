import path from "node:path";
import { access, readFile } from "node:fs/promises";
import {
  appendHarnessLog,
  appendHarnessNote,
  createRunLayout,
  lastAttemptNumber,
  nextCycleNumber,
  openRunLayout,
  resolveArtifactDirsForWorkspace,
  resolveContinueRunDirectory,
  resolveRunDirectoryForWorkspace,
  writeJsonFile,
  writeStatusFile,
} from "./runArtifacts.js";
import { logPhase, runIsolatedAttemptLoop } from "./attemptLoop.js";
import { loadTemplateSpec } from "./specLoader.js";
import type {
  ChainSigner,
  CliOptions,
  RunReport,
  SemanticValidationResult,
} from "./types.js";
import { vendorHarnessContext } from "./contextVendor.js";
import { resolveSkillPaths } from "./skillResolver.js";
import { vendorSkills } from "./skillVendor.js";
import {
  commitWorkspaceBaseline,
  ensureWorkspaceGit,
  initWorkspaceGit,
} from "./workspaceGit.js";
import { runDeterministicValidation } from "./validation/index.js";
import {
  assertChainValidationOperatorEnv,
  provisionChainSigner,
  sweepChainSigner,
} from "./validation/chainSigner.js";
import { isValidatorEnabled, runSemanticValidation } from "./semanticValidator.js";
import { seedWorkspace } from "./workspaceSeeder.js";

export async function runHarness(options: CliOptions): Promise<RunReport> {
  const loaded = await loadTemplateSpec(options.specPath);
  const { spec, projectRoot } = loaded;
  const maxAttempts = options.maxAttempts ?? spec.maxAttempts;
  const continueRunDirectory = resolveContinueRunDirectory(options);
  const isContinue = Boolean(continueRunDirectory);
  const layout = isContinue
    ? await openRunLayout(continueRunDirectory!, spec.logging)
    : await createRunLayout(projectRoot, spec.name, spec.logging);
  const startedAt = new Date();
  const cycle = isContinue ? await nextCycleNumber(layout.reportsDirectory) : undefined;
  const startingAttempt = isContinue ? (await lastAttemptNumber(layout.logsDirectory)) + 1 : 1;
  let chainSigner: ChainSigner | undefined;

  // Fail before seeding / generator if Tier 3.5 operator credentials are missing.
  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  logPhase(isContinue ? "Run continued" : "Run started", layout.runDirectory);
  await writeStatusFile(layout.runDirectory, {
    phase: isContinue ? "continued" : "started",
    specName: spec.name,
    runDirectory: layout.runDirectory,
    layoutMode: layout.mode,
    cycle,
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
    await appendHarnessNote(
      layout.notesLogPath,
      `Run continued: ${spec.name} (cycle ${cycle})`,
      [
        `Run directory: ${layout.runDirectory}`,
        `Spec: ${loaded.specPath}`,
        `Starting attempt: ${startingAttempt}`,
        `Budget this cycle: ${maxAttempts} attempt(s)`,
      ].join("\n"),
    );
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
    await appendHarnessNote(
      layout.notesLogPath,
      `Run started: ${spec.name}`,
      `Run directory: ${layout.runDirectory}\nSpec: ${loaded.specPath}`,
    );
  }

  let seedResult: {
    workspacePath: string;
    repo: string;
    ref: string;
    commitSha: string;
  };

  if (!spec.seed) {
    throw new Error('Isolated `run` requires a `seed` block in the template spec.');
  }

  if (isContinue) {
    seedResult = await loadPriorSeedInfo(layout);
    logPhase("Reusing existing workspace", seedResult.workspacePath);
  } else {
    logPhase("Seeding workspace from scaffold-hbar main", spec.seed.ref);
    const seeded = await seedWorkspace({
      seed: spec.seed,
      runDirectory: layout.runDirectory,
      workspacePath: layout.workspacePath,
      runPreflight: true,
    });
    seedResult = {
      workspacePath: seeded.workspacePath,
      repo: seeded.repo,
      ref: seeded.ref,
      commitSha: seeded.commitSha,
    };
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "workspace_seeded",
      timestamp: new Date().toISOString(),
      seedCommitSha: seedResult.commitSha,
      workspacePath: seedResult.workspacePath,
    });
    await writeStatusFile(layout.runDirectory, {
      phase: "seeded",
      seedCommitSha: seedResult.commitSha,
      workspacePath: seedResult.workspacePath,
    });
    logPhase("Workspace seeded", seedResult.workspacePath);
  }

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

  if (isContinue) {
    const gitState = await ensureWorkspaceGit(seedResult.workspacePath);
    if (gitState.initialized) {
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "workspace_git_initialized",
        timestamp: new Date().toISOString(),
        commitSha: gitState.commitSha,
      });
      logPhase("Workspace git initialized", gitState.commitSha.slice(0, 8));
    } else {
      const baseline = await commitWorkspaceBaseline(
        seedResult.workspacePath,
        `harness: continue cycle ${cycle} baseline (re-vendored context)`,
      );
      await appendHarnessLog(layout.jsonlLogPath, {
        type: "workspace_git_committed",
        timestamp: new Date().toISOString(),
        attempt: startingAttempt - 1,
        committed: baseline.committed,
        commitSha: baseline.commitSha,
        message: baseline.message,
      });
      if (baseline.committed && baseline.commitSha) {
        logPhase("Continue baseline committed", `${baseline.message} @ ${baseline.commitSha.slice(0, 8)}`);
      }
    }
  } else {
    const gitInit = await initWorkspaceGit(seedResult.workspacePath);
    await appendHarnessLog(layout.jsonlLogPath, {
      type: "workspace_git_initialized",
      timestamp: new Date().toISOString(),
      commitSha: gitInit.commitSha,
    });
    logPhase("Workspace git initialized", gitInit.commitSha.slice(0, 8));
  }

  if (spec.chainValidation?.enabled) {
    const provisioned = await provisionChainSigner(spec.chainValidation, layout.runDirectory, {
      projectRoot: process.cwd(),
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
    await appendHarnessNote(
      layout.notesLogPath,
      "Chain signer provisioned",
      [
        `accountId=${chainSigner.accountId}`,
        `evmAddress=${chainSigner.evmAddress}`,
        `reused=${provisioned.reused}`,
        `fundingHbar=${spec.chainValidation.fundingHbar}`,
        ...(provisioned.toppedUpHbar !== undefined
          ? [`toppedUpHbar=${provisioned.toppedUpHbar}`]
          : []),
        ...(provisioned.replacedDeleted ? ["replacedDeleted=true"] : []),
      ].join("\n"),
    );
    logPhase(
      provisioned.replacedDeleted
        ? "Chain signer replaced (prior account deleted)"
        : provisioned.reused
          ? provisioned.toppedUpHbar !== undefined
            ? "Chain signer reused + topped up"
            : "Chain signer reused"
          : "Chain signer provisioned",
      provisioned.toppedUpHbar !== undefined
        ? `${chainSigner.accountId} (+${provisioned.toppedUpHbar} HBAR → ${spec.chainValidation.fundingHbar})`
        : `${chainSigner.accountId} (${chainSigner.evmAddress})`,
    );
  }

  try {
    return await runIsolatedAttemptLoop({
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

export async function validateWorkspace(options: CliOptions) {
  if (!options.workspacePath) {
    throw new Error('Expected --workspace <path> for validate command.');
  }

  // Extend recipes omit `seed`; validate only needs deterministic gates on a workspace.
  const loaded = await loadTemplateSpec(options.specPath, { requireSeed: false });
  return runDeterministicValidation(options.workspacePath, loaded.spec);
}

/**
 * Run Tier 3 semantic validation alone against an existing workspace
 * (skips generator + deterministic gates). Re-vendors PRD/contract/Playwright MCP
 * so older runs pick up current harness tooling.
 */
export async function validateSemanticWorkspace(options: CliOptions): Promise<SemanticValidationResult> {
  if (!options.workspacePath) {
    throw new Error('Expected --workspace <path> for validate-semantic command.');
  }

  const workspacePath = path.resolve(options.workspacePath);
  await access(workspacePath);

  const loaded = await loadTemplateSpec(options.specPath, { requireSeed: false });
  const { spec } = loaded;

  if (!isValidatorEnabled(spec)) {
    throw new Error(
      "Semantic validator is not enabled in the spec (set validator.enabled: true or configure validator).",
    );
  }

  if (!spec.contractPath) {
    throw new Error("Semantic validation requires spec.contract to be configured.");
  }

  if (spec.chainValidation?.enabled) {
    assertChainValidationOperatorEnv(spec.chainValidation);
  }

  const vendored = await vendorHarnessContext(workspacePath, {
    prdPath: spec.prdPath,
    contractPath: spec.contractPath,
  });
  logPhase(
    "Harness context refreshed for semantic validation",
    `.harness-context + ${vendored.playwrightMcpPath ?? "no playwright MCP"}`,
  );

  const artifactDirs = await resolveArtifactDirsForWorkspace(workspacePath);
  const attempt = (await lastAttemptNumber(artifactDirs.logsDirectory)) + 1;

  let chainSigner: ChainSigner | undefined;
  if (spec.chainValidation?.enabled) {
    const runDirectory = await resolveRunDirectoryForWorkspace(workspacePath);
    const provisioned = await provisionChainSigner(spec.chainValidation, runDirectory, {
      projectRoot: process.cwd(),
      packageManager: spec.constraints?.packageManager,
    });
    chainSigner = provisioned.signer;
    logPhase(
      provisioned.reused
        ? provisioned.toppedUpHbar !== undefined
          ? "Chain signer reused + topped up"
          : "Chain signer reused"
        : "Chain signer provisioned",
      provisioned.toppedUpHbar !== undefined
        ? `${chainSigner.accountId} (+${provisioned.toppedUpHbar} HBAR → ${spec.chainValidation.fundingHbar})`
        : `${chainSigner.accountId} (${chainSigner.evmAddress})`,
    );
  }

  logPhase(`Semantic validation attempt ${attempt} started`, workspacePath);

  const result = await runSemanticValidation({
    workspacePath,
    spec,
    attempt,
    logsDirectory: artifactDirs.logsDirectory,
    promptsDirectory: artifactDirs.promptsDirectory,
    chainSigner,
  });

  const resultPath = path.join(artifactDirs.logsDirectory, `semantic-validation-attempt-${attempt}.json`);
  await writeJsonFile(resultPath, result);

  logPhase(
    `Semantic validation ${result.passed ? "passed" : "failed"}`,
    `${result.findings.length} finding(s), ${Math.round(result.durationMs / 1000)}s — ${resultPath}`,
  );

  return result;
}

async function loadPriorSeedInfo(layout: {
  runDirectory: string;
  workspacePath: string;
  reportPath: string;
}): Promise<{ workspacePath: string; repo: string; ref: string; commitSha: string }> {
  try {
    const raw = await readFile(layout.reportPath, "utf8");
    const report = JSON.parse(raw) as RunReport;
    return {
      workspacePath: layout.workspacePath,
      repo: report.seedRepo,
      ref: report.seedRef,
      commitSha: report.seedCommitSha,
    };
  } catch {
    throw new Error(
      `Cannot continue run: missing or invalid report at ${layout.reportPath}. Start with a fresh \`run\` first.`,
    );
  }
}
