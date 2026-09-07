import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveAppWorkspace } from "./appWorkspace.js";
import { inspectNextAssetHealth } from "./nextAssetHealth.js";

const STATE_REL = [".harness", "dev-server.json"] as const;
const LIVE_PORTS = [3000, 3001, 3002, 3003];
const START_TIMEOUT_MS = 120_000;

export type DevServeAction = "start" | "stop" | "status";

interface DevServerState {
  pid: number;
  url: string;
  workspace: string;
}

export interface DevServeReport {
  action: DevServeAction;
  running: boolean;
  reused: boolean;
  url: string;
  pid: number;
  cssOk: boolean;
  killed: number;
  note: string;
}

export function formatDevServeReport(report: DevServeReport): string {
  return [
    `dev=${report.running ? "running" : "down"}`,
    `action=${report.action}`,
    `reused=${report.reused}`,
    `url=${report.url || "none"}`,
    `pid=${report.pid || 0}`,
    `css=${report.cssOk ? "ok" : "missing"}`,
    `killed=${report.killed}`,
    report.note ? `note=${report.note}` : undefined,
    "nohup=forbidden — this PID is tracked in .harness/dev-server.json",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export async function runDevServe(workspaceDir: string, action: DevServeAction): Promise<DevServeReport> {
  const workspace = resolveAppWorkspace(workspaceDir);
  if (action === "stop") return stopDevServe(workspace);
  if (action === "status") return statusDevServe(workspace);
  return startDevServe(workspace);
}

export function commandLineLooksLikeWorkspaceNextDev(commandLine: string, workspaceDir: string): boolean {
  const cmd = commandLine.replace(/\\/g, "/").toLowerCase();
  const ws = path.resolve(workspaceDir).replace(/\\/g, "/").toLowerCase();
  if (!cmd.includes(ws)) return false;
  if (cmd.includes("next:build") || /\bnext\s+build\b/.test(cmd)) return false;
  return (
    cmd.includes("next:dev") ||
    cmd.includes("next:start") ||
    /(?:^|[\s"'\\/])next(?:\.js)?["'\s]+dev\b/.test(cmd) ||
    (cmd.includes("/next/dist/bin/next") && cmd.includes("dev"))
  );
}

async function startDevServe(workspace: string): Promise<DevServeReport> {
  const existing = await statusDevServe(workspace);
  if (existing.running && existing.cssOk) {
    return {
      ...existing,
      action: "start",
      reused: true,
      note: "Reused the tracked next:dev. Did not spawn a second process (that is how 3000-in-use → 3001 + stale .next happens).",
    };
  }

  const killed = stopWorkspaceNextDev(workspace);
  wipeProductionNextCache(workspace);

  const child = spawn("yarn", ["next:dev"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore",
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
    windowsHide: true,
  });
  const pid = child.pid ?? 0;
  child.unref();
  if (!pid) {
    return {
      action: "start",
      running: false,
      reused: false,
      url: "",
      pid: 0,
      cssOk: false,
      killed,
      note: "yarn next:dev did not start (no pid).",
    };
  }

  const deadline = Date.now() + START_TIMEOUT_MS;
  let url = "";
  let cssOk = false;
  while (Date.now() < deadline) {
    const probe = await probeLocalApp();
    if (probe.url && probe.cssOk) {
      url = probe.url;
      cssOk = true;
      break;
    }
    if (probe.url) url = probe.url;
    await sleep(1_000);
  }

  writeState(workspace, { pid, url: url || "http://127.0.0.1:3000", workspace });
  return {
    action: "start",
    running: cssOk,
    reused: false,
    url: url || "http://127.0.0.1:3000",
    pid,
    cssOk,
    killed,
    note: cssOk
      ? killed > 0
        ? `Killed ${killed} leftover next:dev (nohup/orphan), then started a tracked one.`
        : "Started tracked yarn next:dev."
      : "next:dev started but CSS/JS never 200. Delete packages/nextjs/.next and call start again.",
  };
}

async function statusDevServe(workspace: string): Promise<DevServeReport> {
  const state = readState(workspace);
  const probe = await probeLocalApp();
  const pid = state?.pid && isPidAlive(state.pid) ? state.pid : 0;
  const running = Boolean(pid) || probe.cssOk;
  return {
    action: "status",
    running,
    reused: false,
    url: probe.url || state?.url || "",
    pid,
    cssOk: probe.cssOk,
    killed: 0,
    note: running
      ? probe.cssOk
        ? "next:dev is up."
        : "A Next process is up but /_next CSS 404s — call start (it will kill leftovers)."
      : "No tracked next:dev.",
  };
}

function stopDevServe(workspace: string): DevServeReport {
  const killed = stopWorkspaceNextDev(workspace);
  const statePath = stateFile(workspace);
  if (existsSync(statePath)) {
    try {
      rmSync(statePath);
    } catch {
      // ignore
    }
  }
  return {
    action: "stop",
    running: false,
    reused: false,
    url: "",
    pid: 0,
    cssOk: false,
    killed,
    note: killed > 0 ? `Stopped ${killed} next:dev process(es).` : "Nothing to stop.",
  };
}

function stopWorkspaceNextDev(workspace: string): number {
  const pids = new Set<number>();
  const state = readState(workspace);
  if (state?.pid) pids.add(state.pid);
  for (const proc of listNodeProcesses()) {
    if (commandLineLooksLikeWorkspaceNextDev(proc.cmd, workspace)) pids.add(proc.pid);
  }
  let killed = 0;
  for (const pid of pids) {
    if (killPidTree(pid)) killed += 1;
  }
  return killed;
}

function wipeProductionNextCache(workspace: string): void {
  const buildId = path.join(workspace, "packages", "nextjs", ".next", "BUILD_ID");
  if (!existsSync(buildId)) return;
  rmSync(path.join(workspace, "packages", "nextjs", ".next"), { recursive: true, force: true });
}

async function probeLocalApp(): Promise<{ url: string; cssOk: boolean }> {
  let htmlOnly = "";
  for (const host of ["127.0.0.1", "localhost"]) {
    for (const port of LIVE_PORTS) {
      const url = `http://${host}:${port}`;
      try {
        const health = await inspectNextAssetHealth(url);
        if (health.htmlOk && health.cssOk && health.jsOk) return { url, cssOk: true };
        if (health.htmlOk && !htmlOnly) htmlOnly = url;
      } catch {
        // try next port
      }
    }
  }
  return { url: htmlOnly, cssOk: false };
}

function listNodeProcesses(): Array<{ pid: number; cmd: string }> {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|yarn' } | ForEach-Object { '{0}`t{1}' -f $_.ProcessId, $_.CommandLine }",
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
      );
      return parsePidCmdLines(out);
    }
    const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return parsePidCmdLines(out.replace(/^(\s*\d+)\s+/gm, "$1\t"));
  } catch {
    return [];
  }
}

function parsePidCmdLines(text: string): Array<{ pid: number; cmd: string }> {
  const rows: Array<{ pid: number; cmd: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    const raw = tab === -1 ? line.trim() : line;
    const match = raw.match(/^\s*(\d+)\s+[\t ](.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const cmd = match[2]?.trim() ?? "";
    if (pid > 0 && cmd) rows.push({ pid, cmd });
  }
  return rows;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPidTree(pid: number): boolean {
  if (!pid || !isPidAlive(pid)) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
    return true;
  } catch {
    return false;
  }
}

function stateFile(workspace: string): string {
  return path.join(workspace, ...STATE_REL);
}

function readState(workspace: string): DevServerState | undefined {
  const file = stateFile(workspace);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DevServerState>;
    if (typeof raw.pid !== "number" || typeof raw.url !== "string") return undefined;
    return { pid: raw.pid, url: raw.url, workspace: String(raw.workspace || workspace) };
  } catch {
    return undefined;
  }
}

function writeState(workspace: string, state: DevServerState): void {
  const file = stateFile(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
