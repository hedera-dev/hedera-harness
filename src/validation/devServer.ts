import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { parse as parseYaml } from "yaml";

const LOCAL_URL_PATTERN = /Local:\s*(https?:\/\/[^\s-]+)/i;
const URL_DETECT_TIMEOUT_MS = 30_000;

export interface DevServerHandle {
  process: ChildProcess;
  configuredUrl: string;
  detectedUrl: Promise<string>;
}

export interface DevServerConfig {
  command: string;
  configuredUrl: string;
  timeoutMs: number;
}

/** Live dev server reused by Playwright gate and semantic validator within one attempt. */
export interface DevServerSession {
  readonly url: string;
  readonly serverCommand: string;
  stop(): Promise<void>;
}

export async function createDevServerSession(
  workspacePath: string,
  config: DevServerConfig,
  logPrefix = "dev",
): Promise<DevServerSession> {
  const handle = startDevServer(workspacePath, config.command, config.configuredUrl, logPrefix);
  const url = await handle.detectedUrl;
  await waitForServer(url, config.timeoutMs);

  if (url !== config.configuredUrl) {
    console.log(
      `[hedera-harness] Dev server using detected URL ${url} (config specified ${config.configuredUrl})`,
    );
  }

  return {
    url,
    serverCommand: config.command,
    async stop() {
      await stopDevServer(handle);
    },
  };
}

export async function loadDevServerConfig(playwrightConfigPath: string): Promise<DevServerConfig> {
  const raw = await readFile(playwrightConfigPath, "utf8");
  const parsed = parseYaml(raw) as {
    server?: { command?: string; url?: string; timeoutMs?: number };
  };

  if (!parsed.server?.command || !parsed.server?.url) {
    throw new Error(`Playwright config ${playwrightConfigPath} requires server.command and server.url.`);
  }

  return {
    command: parsed.server.command,
    configuredUrl: parsed.server.url,
    timeoutMs: parsed.server.timeoutMs ?? 120_000,
  };
}

export function startDevServer(
  workspacePath: string,
  command: string,
  configuredUrl: string,
  logPrefix = "playwright",
): DevServerHandle {
  let resolveUrl: (url: string) => void = () => undefined;
  let rejectUrl: (error: Error) => void = () => undefined;
  let settled = false;

  const detectedUrl = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });

  const settleUrl = (url: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(detectTimer);
    resolveUrl(normalizeBaseUrl(url));
  };

  const failUrl = (error: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(detectTimer);
    rejectUrl(error);
  };

  const detectTimer = setTimeout(() => {
    failUrl(
      new Error(
        `Dev server did not report a Local URL within ${URL_DETECT_TIMEOUT_MS}ms. Expected output like "Local: http://localhost:3000".`,
      ),
    );
  }, URL_DETECT_TIMEOUT_MS);

  // detached: true makes this child the leader of a new process group so
  // stopDevServer can signal -pid and tear down yarn/next grandchildren.
  const child = spawn(command, {
    cwd: workspacePath,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  const onServerOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const trimmed = text.trim();
    if (trimmed) {
      const prefix =
        stream === "stderr"
          ? `[hedera-harness:${logPrefix}:server:stderr]`
          : `[hedera-harness:${logPrefix}:server]`;
      console.log(`${prefix} ${truncate(trimmed.replace(/\s+/g, " "), 240)}`);
    }

    const localUrl = extractLocalUrl(text);
    if (localUrl) {
      settleUrl(localUrl);
    }

    if (/Port \d+ is in use/i.test(text)) {
      console.log(
        `[hedera-harness] ${logPrefix} detected a port conflict; health checks will follow the server's reported Local URL.`,
      );
    }
  };

  child.stdout?.on("data", chunk => onServerOutput("stdout", Buffer.from(chunk)));
  child.stderr?.on("data", chunk => onServerOutput("stderr", Buffer.from(chunk)));

  child.on("error", error => {
    failUrl(error instanceof Error ? error : new Error(String(error)));
  });

  child.on("close", (exitCode, signal) => {
    if (settled) return;
    const reason = signal ? `signal ${signal}` : `exit code ${exitCode ?? "null"}`;
    failUrl(new Error(`Dev server exited before reporting a Local URL (${reason}).`));
  });

  return {
    process: child,
    configuredUrl,
    detectedUrl,
  };
}

export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "server not ready";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (response.status >= 200 && response.status < 400) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1_000);
  }

  throw new Error(`Dev server did not become ready at ${url} within ${timeoutMs}ms (${lastError}).`);
}

export async function stopDevServer(target: DevServerHandle | ChildProcess | null): Promise<void> {
  const child = target && "process" in target && "detectedUrl" in target ? target.process : target;
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      destroyStdio(child);
      resolve();
    };

    const forceKill = setTimeout(() => {
      signalProcessTree(child, "SIGKILL");
      // Don't hang forever if the process group is already gone.
      setTimeout(finish, 1_000);
    }, 5_000);

    child.once("close", finish);
    signalProcessTree(child, "SIGTERM");
  });
}

/** Kill the shell and its yarn/next descendants (Unix process group). */
function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }

  try {
    // Negative PID targets the process group created by detached: true.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

function destroyStdio(child: ChildProcess): void {
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function extractLocalUrl(text: string): string | null {
  const match = text.match(LOCAL_URL_PATTERN);
  return match?.[1] ?? null;
}

export function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
