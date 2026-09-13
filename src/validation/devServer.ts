import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "../command.js";
import { parse as parseYaml } from "yaml";

const LOCAL_URL_PATTERN = /Local:\s*(https?:\/\/[^\s-]+)/i;
const PORT_IN_USE_PATTERN = /Port (\d+) is in use/i;
const READY_POLL_MS = 1_000;
/** Bound on one readiness probe, so a socket that accepts but never answers cannot stall the budget. */
const PROBE_TIMEOUT_MS = 5_000;

export interface DevServerConfig {
  command: string;
  configuredUrl: string;
  timeoutMs: number;
}

interface DevServerHandle {
  process: ChildProcess;
  configuredUrl: string;
  /** The URL the server printed in a `Local:` line, once it has. */
  localUrl?: string;
  /**
   * True when `configuredUrl` cannot be this server: something answered there
   * before it started, or it reported the port as taken and moved elsewhere.
   */
  configuredPortTaken: boolean;
  /** Set when the process exits or fails to spawn; read while waiting for readiness. */
  exitError?: Error;
}

/** Live dev server reused by Playwright gate and semantic validator within one attempt. */
export interface DevServerSession {
  readonly url: string;
  readonly serverCommand: string;
  /** False once the child process has exited. */
  isAlive(): boolean;
  stop(): Promise<void>;
}

/**
 * Sole entrypoint for spawn → readiness → teardown-on-failure.
 *
 * Callers borrow the returned session; gates must not spawn their own servers.
 */
export async function createDevServerSession(
  workspacePath: string,
  config: DevServerConfig,
  logPrefix = "dev",
): Promise<DevServerSession> {
  // Anything already answering at server.url before the server starts is not
  // the server, whatever it answers, so only a URL the server prints itself can
  // be trusted then.
  const configuredPortTaken = (await probeUrl(config.configuredUrl)).responded;
  if (configuredPortTaken) {
    console.log(
      `[hedera-harness] ${logPrefix}: ${config.configuredUrl} already answers before the dev server started; following the server's reported Local URL only.`,
    );
  }

  const handle = startDevServer(workspacePath, config, logPrefix, configuredPortTaken);

  let url: string;
  try {
    url = await waitForReadyUrl(handle, config.timeoutMs);
  } catch (error) {
    // The child leads a detached process group; without this it survives the
    // failed startup and keeps the port held for the rest of the session.
    await stopDevServer(handle);
    throw error;
  }

  if (url !== config.configuredUrl) {
    console.log(
      `[hedera-harness] Dev server using detected URL ${url} (config specified ${config.configuredUrl})`,
    );
  } else if (!handle.localUrl) {
    console.log(
      `[hedera-harness] Dev server ready at ${url} (it printed no "Local:" line, so server.url was polled directly)`,
    );
  }

  let stopped = false;
  return {
    url,
    serverCommand: config.command,
    isAlive() {
      if (stopped) return false;
      return handle.process.exitCode === null && !handle.process.killed;
    },
    async stop() {
      stopped = true;
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

function startDevServer(
  workspacePath: string,
  config: DevServerConfig,
  logPrefix: string,
  configuredPortTaken: boolean,
): DevServerHandle {
  // detached: true makes this child the leader of a new process group so
  // stopDevServer can signal -pid and tear down yarn/next grandchildren.
  const child = spawn(config.command, {
    cwd: workspacePath,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  const handle: DevServerHandle = {
    process: child,
    configuredUrl: config.configuredUrl,
    configuredPortTaken,
  };

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
    if (localUrl && !handle.localUrl) {
      handle.localUrl = normalizeBaseUrl(localUrl);
    }

    // Only the configured port matters: an app may report an auxiliary port
    // as taken (a websocket, a proxy) and still serve server.url fine.
    const inUse = PORT_IN_USE_PATTERN.exec(text);
    if (inUse && inUse[1] === portOf(config.configuredUrl)) {
      handle.configuredPortTaken = true;
      console.log(
        `[hedera-harness] ${logPrefix} detected a port conflict; health checks will follow the server's reported Local URL.`,
      );
    }
  };

  child.stdout?.on("data", chunk => onServerOutput("stdout", Buffer.from(chunk)));
  child.stderr?.on("data", chunk => onServerOutput("stderr", Buffer.from(chunk)));

  child.on("error", error => {
    handle.exitError ??= error instanceof Error ? error : new Error(String(error));
  });

  child.on("close", (exitCode, signal) => {
    const reason = signal ? `signal ${signal}` : `exit code ${exitCode ?? "null"}`;
    handle.exitError ??= new Error(`Dev server exited before it became ready (${reason}).`);
  });

  return handle;
}

/**
 * Resolve the URL the gate should drive.
 *
 * Two signals race. A `Local:` line names the URL the server actually bound,
 * which is the only reliable answer when it moved off a taken port. Most
 * servers outside Next and Vite never print one (Express says "listening on
 * http://…"), so the configured `server.url` is polled in parallel and wins as
 * soon as it answers — unless that port is known to belong to someone else, in
 * which case only the printed URL is trusted.
 *
 * Any HTTP answer below 500 means the server is up. Status codes are judged per
 * route by the gate: an API whose root answers 404 is ready, not broken.
 */
async function waitForReadyUrl(handle: DevServerHandle, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "no response yet";

  for (;;) {
    if (handle.exitError) throw handle.exitError;

    const candidate = handle.localUrl ?? (handle.configuredPortTaken ? undefined : handle.configuredUrl);
    if (candidate) {
      const probe = await probeUrl(candidate, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
      if (probe.ready) return candidate;
      lastReason = probe.reason;
    } else {
      lastReason = "the configured port is taken and the server has not printed a Local: URL";
    }

    if (Date.now() >= deadline) {
      const hint = handle.localUrl
        ? ""
        : handle.configuredPortTaken
          ? ` ${handle.configuredUrl} was already taken, so only a "Local: http://…" line printed by the server could be used, and none appeared.`
          : ` It printed no "Local: http://…" line, so server.url was polled; check that it names the port the server listens on.`;
      throw new Error(
        `Dev server did not become ready at ${candidate ?? handle.configuredUrl} within ${timeoutMs}ms (${lastReason}).${hint}`,
      );
    }

    await sleep(READY_POLL_MS);
  }
}

/**
 * `responded` — something answered HTTP at all (occupancy).
 * `ready` — it answered below 500 (up; the gate judges each route's status).
 * A 5xx is a server still starting or a proxy with no upstream: occupied, not ready.
 */
async function probeUrl(
  url: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ responded: boolean; ready: boolean; reason: string }> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return { responded: true, ready: response.status < 500, reason: `HTTP ${response.status}` };
  } catch (error) {
    return {
      responded: false,
      ready: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The port a URL names, with the scheme default filled in; "" when the URL does not parse. */
function portOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  } catch {
    return "";
  }
}

async function stopDevServer(handle: DevServerHandle): Promise<void> {
  const child = handle.process;
  if (child.exitCode !== null) {
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
      killProcessTree(child, "SIGKILL");
      // Don't hang forever if the process group is already gone.
      setTimeout(finish, 1_000);
    }, 5_000);

    child.once("close", finish);
    killProcessTree(child, "SIGTERM");
  });
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
