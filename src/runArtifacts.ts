import { appendFile, access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessLogEvent } from "./types.js";

/** Artifact layout for project-centric run: code stays in cwd, runtime under `.harness/runs/<id>/`. */
export const LAYOUT_MODE_IN_PLACE_RUN = "in-place-run" as const;

export type RunLayoutMode = typeof LAYOUT_MODE_IN_PLACE_RUN;

const LAYOUT_META_FILENAME = "layout.json";
const LAYOUT_META_SCHEMA_VERSION = 1;

export interface RunLayoutMeta {
  schemaVersion: number;
  mode: RunLayoutMode;
  workspacePath: string;
}

export interface RunLayout {
  mode: RunLayoutMode;
  runDirectory: string;
  workspacePath: string;
  promptsDirectory: string;
  logsDirectory: string;
  reportsDirectory: string;
  cacheDirectory: string;
  reportPath: string;
  jsonlLogPath: string;
  notesLogPath: string;
}

export interface WorkspaceArtifactDirs {
  mode: RunLayoutMode | "ad-hoc";
  runDirectory: string | null;
  logsDirectory: string;
  promptsDirectory: string;
}

/**
 * Project-centric run layout: generated code lives in `workspacePath` (typically cwd);
 * prompts, logs, reports, cache, and status live under `.harness/runs/<id>/`.
 */
export async function createSessionLayout(
  workspacePath: string,
  specName: string,
  logging: { jsonlPath: string; notesPath: string },
): Promise<RunLayout> {
  const absoluteWorkspace = path.resolve(workspacePath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDirectory = path.join(absoluteWorkspace, ".harness", "runs", `${timestamp}-${specName}`);
  return createLayoutDirectories({
    mode: LAYOUT_MODE_IN_PLACE_RUN,
    runDirectory,
    workspacePath: absoluteWorkspace,
    logging,
  });
}

/** Reopen an existing accumulating run directory (for --continue or extend resume). */
export async function openRunLayout(
  runDirectory: string,
  logging: { jsonlPath: string; notesPath: string },
): Promise<RunLayout> {
  const absoluteRunDirectory = path.resolve(runDirectory);
  const meta = await readLayoutMeta(absoluteRunDirectory);
  const mode = meta?.mode ?? LAYOUT_MODE_IN_PLACE_RUN;
  const workspacePath =
    meta?.workspacePath ?? resolveWorkspaceFromRunDirectory(absoluteRunDirectory);

  await access(workspacePath);

  return createLayoutDirectories({
    mode,
    runDirectory: absoluteRunDirectory,
    workspacePath,
    logging,
  });
}

export async function readLayoutMeta(runDirectory: string): Promise<RunLayoutMeta | null> {
  try {
    const raw = await readFile(path.join(runDirectory, LAYOUT_META_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<RunLayoutMeta>;
    // Accept legacy on-disk mode from the removed `extend` command.
    const rawMode = parsed.mode as string | undefined;
    const normalizedMode =
      rawMode === "in-place-extend" ? LAYOUT_MODE_IN_PLACE_RUN : parsed.mode;
    if (normalizedMode !== LAYOUT_MODE_IN_PLACE_RUN) {
      return null;
    }
    if (typeof parsed.workspacePath !== "string" || !parsed.workspacePath) {
      return null;
    }
    return {
      schemaVersion: parsed.schemaVersion ?? LAYOUT_META_SCHEMA_VERSION,
      mode: normalizedMode,
      workspacePath: path.resolve(parsed.workspacePath),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve artifact directories for validate-semantic / similar helpers using
 * persisted layout metadata when available (instead of basename heuristics alone).
 */
export async function resolveArtifactDirsForWorkspace(
  workspacePath: string,
): Promise<WorkspaceArtifactDirs> {
  const resolvedWorkspace = path.resolve(workspacePath);
  const parent = path.dirname(resolvedWorkspace);

  const fromParent = await artifactDirsFromRunDirectory(parent, resolvedWorkspace);
  if (fromParent) {
    return fromParent;
  }

  const fromHarnessRuns = await findHarnessArtifactDirs(resolvedWorkspace);
  if (fromHarnessRuns) {
    return fromHarnessRuns;
  }

  const logsDirectory = path.join(resolvedWorkspace, ".harness-semantic", "logs");
  const promptsDirectory = path.join(resolvedWorkspace, ".harness-semantic", "prompts");
  await mkdir(logsDirectory, { recursive: true });
  await mkdir(promptsDirectory, { recursive: true });
  return {
    mode: "ad-hoc",
    runDirectory: null,
    logsDirectory,
    promptsDirectory,
  };
}

/** Resolve the harness run directory that owns a workspace, when known. */
export async function resolveRunDirectoryForWorkspace(workspacePath: string): Promise<string> {
  const dirs = await resolveArtifactDirsForWorkspace(workspacePath);
  if (dirs.runDirectory) {
    return dirs.runDirectory;
  }
  return path.resolve(workspacePath);
}

/** Highest attempt number seen in logs/*-attempt-N.* filenames. */
export async function lastAttemptNumber(logsDirectory: string): Promise<number> {
  let maxAttempt = 0;
  try {
    const entries = await readdir(logsDirectory);
    for (const entry of entries) {
      const match = /-attempt-(\d+)(?:\.|$)/.exec(entry);
      if (match) {
        maxAttempt = Math.max(maxAttempt, Number.parseInt(match[1], 10));
      }
    }
  } catch {
    // empty / missing
  }
  return maxAttempt;
}

export async function nextAttemptNumber(logsDirectory: string): Promise<number> {
  return (await lastAttemptNumber(logsDirectory)) + 1;
}

/** 1-based cycle index for the next --continue kick. */
export async function nextCycleNumber(reportsDirectory: string): Promise<number> {
  let maxCycle = 0;
  try {
    const entries = await readdir(reportsDirectory);
    for (const entry of entries) {
      const match = /^cycle-(\d+)\.json$/.exec(entry);
      if (match) {
        maxCycle = Math.max(maxCycle, Number.parseInt(match[1], 10));
      }
    }
  } catch {
    // empty / missing
  }
  return maxCycle + 1;
}

export async function appendHarnessLog(jsonlLogPath: string, event: HarnessLogEvent): Promise<void> {
  await appendFile(jsonlLogPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function appendHarnessNote(
  notesLogPath: string,
  title: string,
  body: string,
): Promise<void> {
  const entry = `\n## ${title}\n\n${body.trim()}\n`;
  await appendFile(notesLogPath, entry, "utf8");
}

export async function writePromptFile(promptPath: string, prompt: string): Promise<void> {
  await writeFile(promptPath, `${prompt.trim()}\n`, "utf8");
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeStatusFile(
  runDirectory: string,
  status: Record<string, unknown>,
): Promise<void> {
  await writeJsonFile(path.join(runDirectory, "status.json"), {
    updatedAt: new Date().toISOString(),
    ...status,
  });
}

async function createLayoutDirectories(input: {
  mode: RunLayoutMode;
  runDirectory: string;
  workspacePath: string;
  logging: { jsonlPath: string; notesPath: string };
}): Promise<RunLayout> {
  const promptsDirectory = path.join(input.runDirectory, "prompts");
  const logsDirectory = path.join(input.runDirectory, "logs");
  const reportsDirectory = path.join(input.runDirectory, "reports");
  const cacheDirectory = path.join(input.runDirectory, "cache");

  await mkdir(input.runDirectory, { recursive: true });
  await mkdir(promptsDirectory, { recursive: true });
  await mkdir(logsDirectory, { recursive: true });
  await mkdir(reportsDirectory, { recursive: true });
  await mkdir(cacheDirectory, { recursive: true });
  await mkdir(path.dirname(input.logging.jsonlPath), { recursive: true });
  await mkdir(path.dirname(input.logging.notesPath), { recursive: true });

  const layout: RunLayout = {
    mode: input.mode,
    runDirectory: input.runDirectory,
    workspacePath: input.workspacePath,
    promptsDirectory,
    logsDirectory,
    reportsDirectory,
    cacheDirectory,
    reportPath: path.join(reportsDirectory, "report.json"),
    jsonlLogPath: input.logging.jsonlPath,
    notesLogPath: input.logging.notesPath,
  };

  await writeJsonFile(path.join(input.runDirectory, LAYOUT_META_FILENAME), {
    schemaVersion: LAYOUT_META_SCHEMA_VERSION,
    mode: layout.mode,
    workspacePath: layout.workspacePath,
  } satisfies RunLayoutMeta);

  return layout;
}

function resolveWorkspaceFromRunDirectory(runDirectory: string): string {
  // `.harness/runs/<id>` → project root
  return path.resolve(runDirectory, "..", "..", "..");
}

async function artifactDirsFromRunDirectory(
  runDirectory: string,
  expectedWorkspace: string,
): Promise<WorkspaceArtifactDirs | null> {
  const meta = await readLayoutMeta(runDirectory);
  if (!meta || path.resolve(meta.workspacePath) !== expectedWorkspace) {
    return null;
  }

  const promptsDirectory = path.join(runDirectory, "prompts");
  await mkdir(promptsDirectory, { recursive: true });
  return {
    mode: meta.mode,
    runDirectory,
    logsDirectory: path.join(runDirectory, "logs"),
    promptsDirectory,
  };
}

/**
 * Prefer the newest `.harness/runs/<id>` whose layout metadata points at this workspace.
 */
async function findHarnessArtifactDirs(workspacePath: string): Promise<WorkspaceArtifactDirs | null> {
  const runsRoot = path.join(workspacePath, ".harness", "runs");
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return null;
  }

  const matches: WorkspaceArtifactDirs[] = [];
  for (const entry of entries) {
    const runDirectory = path.join(runsRoot, entry);
    const dirs = await artifactDirsFromRunDirectory(runDirectory, workspacePath);
    if (dirs) {
      matches.push(dirs);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => (a.runDirectory! < b.runDirectory! ? 1 : -1));
  return matches[0];
}
