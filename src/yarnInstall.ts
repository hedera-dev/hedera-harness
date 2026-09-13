import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { executeCommand } from "./command.js";

export const YARN_INSTALL_LOG = [".harness", "yarn-install.log"] as const;
export const YARN_INSTALL_STATE = [".harness", "yarn-install.json"] as const;

export type YarnInstallKind = "skip" | "ok" | "fail" | "no-package" | "missing" | "running";

export interface YarnInstallReport {
  kind: YarnInstallKind;
  workspace: string;
  logFile: string;
  elapsedMs: number;
  note: string;
  pid?: number;
}

interface YarnInstallState {
  pid: number;
  startedAt: number;
  logFile: string;
}

export function yarnLogPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...YARN_INSTALL_LOG);
}

export function yarnStatePath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...YARN_INSTALL_STATE);
}

/** True when the scaffold actually has deps, not an empty leftover node_modules. */
export function nodeModulesLooksInstalled(workspaceDir: string): boolean {
  const root = path.resolve(workspaceDir);
  return (
    existsSync(path.join(root, "node_modules", "next")) ||
    existsSync(path.join(root, "packages", "nextjs", "node_modules", "next")) ||
    existsSync(path.join(root, "node_modules", ".yarn-integrity"))
  );
}

export function formatYarnInstallReport(report: YarnInstallReport): string {
  return [
    `yarn=${report.kind}`,
    `workspace=${report.workspace}`,
    `elapsed_ms=${report.elapsedMs}`,
    `log=${report.logFile}`,
    report.pid ? `pid=${report.pid}` : undefined,
    `note=${report.note}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** OpenCode must not install deps. tui install does that in a real terminal. */
export async function ensureYarnInstall(workspaceDir: string): Promise<YarnInstallReport> {
  return inspectYarnInstall(workspaceDir);
}

export function inspectYarnInstall(workspaceDir: string): YarnInstallReport {
  const workspace = path.resolve(workspaceDir);
  const logFile = yarnLogPath(workspace);

  if (!existsSync(path.join(workspace, "package.json"))) {
    return {
      kind: "no-package",
      workspace,
      logFile,
      elapsedMs: 0,
      note: "No package.json — skip yarn install.",
    };
  }
  if (nodeModulesLooksInstalled(workspace)) {
    clearState(workspace);
    return {
      kind: "skip",
      workspace,
      logFile,
      elapsedMs: 0,
      note: "Dependencies already installed.",
    };
  }

  const state = readState(workspace);
  if (state && isPidAlive(state.pid)) {
    return {
      kind: "running",
      workspace,
      logFile,
      elapsedMs: Date.now() - state.startedAt,
      pid: state.pid,
      note: "A leftover yarn pid is still running. Do not start another from OpenCode.",
    };
  }
  if (state && !isPidAlive(state.pid)) {
    clearState(workspace);
    return {
      kind: "missing",
      workspace,
      logFile,
      elapsedMs: Date.now() - state.startedAt,
      pid: state.pid,
      note: `yarn process ${state.pid} exited and next is still missing. Run hedera-harness tui install (or yarn install in a terminal). OpenCode does not install deps.`,
    };
  }

  return {
    kind: "missing",
    workspace,
    logFile,
    elapsedMs: 0,
    note: "node_modules is not installed. Run hedera-harness tui install in a terminal — OpenCode does not run yarn.",
  };
}

/**
 * Blocking yarn install for `tui install`. No timeout. Streams to the terminal.
 * Call this after clone + overlay copy, never from an OpenCode plugin.
 */
export async function runYarnInstallForeground(workspaceDir: string): Promise<YarnInstallReport> {
  const workspace = path.resolve(workspaceDir);
  const logFile = yarnLogPath(workspace);
  const inspected = inspectYarnInstall(workspace);
  if (inspected.kind === "skip" || inspected.kind === "no-package") {
    return inspected;
  }
  if (inspected.kind === "running" && inspected.pid) {
    killPid(inspected.pid);
    clearState(workspace);
  }

  const yarn = resolveYarnInvocation();
  const startedAt = Date.now();
  mkdirSync(path.dirname(logFile), { recursive: true });
  const result = await executeCommand({
    command: yarn.command,
    // Yarn Berry (scaffold-hbar uses 3.x) rejects the old Yarn 1 flag and exits 1 (YN0050).
    args: [...yarn.argsPrefix, "install"],
    cwd: workspace,
    timeoutMs: 0,
    shell: process.platform === "win32",
    streamOutput: true,
  });
  const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  writeFileSync(logFile, `${body}\nexit=${result.exitCode}\n`, "utf8");
  const elapsedMs = Date.now() - startedAt;
  if (result.exitCode !== 0) {
    return {
      kind: "fail",
      workspace,
      logFile,
      elapsedMs,
      note: `yarn install exited ${result.exitCode}.`,
    };
  }
  if (!nodeModulesLooksInstalled(workspace)) {
    return {
      kind: "fail",
      workspace,
      logFile,
      elapsedMs,
      note: "yarn install exited 0 but next is still missing under node_modules.",
    };
  }
  clearState(workspace);
  return {
    kind: "ok",
    workspace,
    logFile,
    elapsedMs,
    note: "yarn install finished. You can open this project in OpenCode.",
  };
}

export function resolveYarnInvocation(): { command: string; argsPrefix: string[] } {
  if (process.platform === "win32") {
    return { command: "yarn.cmd", argsPrefix: [] };
  }
  return { command: "yarn", argsPrefix: [] };
}

function readState(workspace: string): YarnInstallState | undefined {
  const file = yarnStatePath(workspace);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<YarnInstallState>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number") return undefined;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      logFile: String(parsed.logFile || yarnLogPath(workspace)),
    };
  } catch {
    return undefined;
  }
}

function clearState(workspace: string): void {
  const file = yarnStatePath(workspace);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}
