import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { AgentStreamLogger } from "../agentStreamLogger.js";
import type { AgentProvider, AgentRunInput, AgentRunResult, CommandAgentConfig } from "../types.js";

const PROMPT_PLACEHOLDER = "{prompt}";
const WORKSPACE_PLACEHOLDER = "{workspace}";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Kill agent if stream output goes silent (stuck after THINKING completed). */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function readIdleTimeoutMs(): number {
  const raw = process.env.HARNESS_AGENT_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_TIMEOUT_MS;
}

export class CommandAgentProvider implements AgentProvider {
  private readonly config: CommandAgentConfig;

  constructor(config: CommandAgentConfig) {
    if (!config.command.trim()) {
      throw new Error("Command agent provider requires a non-empty command.");
    }

    this.config = {
      ...config,
      args: config.args ?? [],
    };
  }

  run(input: AgentRunInput): Promise<AgentRunResult> {
    if (!input.workspacePath.trim()) {
      throw new Error("Agent run requires a workspace path.");
    }

    if (!input.prompt.trim()) {
      throw new Error("Agent run requires a non-empty prompt.");
    }

    const startedAt = Date.now();
    const args = buildArgs(this.config.args ?? [], {
      prompt: input.prompt,
      workspacePath: input.workspacePath,
    }, input.role);
    const timeoutMs = input.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const idleTimeoutMs = readIdleTimeoutMs();
    const streamLogger = input.activityLogPath
      ? new AgentStreamLogger(input.activityLogPath, input.onProgress)
      : null;

    return new Promise<AgentRunResult>((resolve, reject) => {
      const child = spawn(this.config.command, args, {
        cwd: input.workspacePath,
        env: {
          ...process.env,
          ...this.config.env,
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;
      let idleTimedOut = false;
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let hardKillTimer: NodeJS.Timeout | undefined;

      void initializeAgentLog(input.logPath, this.config.command, args, timeoutMs, idleTimeoutMs);
      void streamLogger?.initialize();

      const settleAgent = (reason: "wall-clock" | "idle") => {
        if (settled) return;
        timedOut = true;
        idleTimedOut = reason === "idle";
        const limitMs = reason === "idle" ? idleTimeoutMs : timeoutMs;
        console.log(
          `[hedera-harness] Agent ${reason === "idle" ? "idle-" : ""}timeout after ${Math.round(limitMs / 1000)}s — stopping agent`,
        );
        void appendAgentLog(
          input.logPath,
          `\n## harness\nagent ${reason === "idle" ? "idle-" : ""}timed out after ${reason === "idle" ? idleTimeoutMs : timeoutMs}ms\n`,
        );
        void streamLogger?.processChunk(
          `${JSON.stringify({
            type: "result",
            subtype: reason === "idle" ? "idle_timeout" : "timeout",
            is_error: true,
            duration_ms: Date.now() - startedAt,
          })}\n`,
        );
        child.kill("SIGTERM");
        hardKillTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, 5_000);
      };

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => settleAgent("idle"), idleTimeoutMs);
      };

      const timeout = setTimeout(() => settleAgent("wall-clock"), timeoutMs);

      resetIdleTimer();

      child.stdout.on("data", chunk => {
        resetIdleTimer();
        const buffer = Buffer.from(chunk);
        stdoutChunks.push(buffer);
        const text = buffer.toString("utf8");
        void appendAgentLog(input.logPath, buffer);
        void streamLogger?.processChunk(text);
      });

      child.stderr.on("data", chunk => {
        resetIdleTimer();
        const buffer = Buffer.from(chunk);
        stderrChunks.push(buffer);
        const text = buffer.toString("utf8");
        void appendAgentLog(input.logPath, `\n## stderr\n${text}`);
        console.log(`[hedera-harness:agent:stderr] ${truncate(text, 300)}`);
      });

      child.on("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        clearTimeout(hardKillTimer);
        reject(error);
      });

      child.on("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(idleTimer);
        clearTimeout(hardKillTimer);

        const result: AgentRunResult = {
          exitCode,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: [
            Buffer.concat(stderrChunks).toString("utf8"),
            idleTimedOut
              ? `\n[hedera-harness] Agent produced no output for ${idleTimeoutMs}ms; treating as failure.\n`
              : "",
          ].join(""),
          durationMs: Date.now() - startedAt,
          command: this.config.command,
          args,
          timedOut,
          signal,
        };

        void finalizeAgentLog(input.logPath, result, streamLogger?.getProgress()).finally(() =>
          resolve(result),
        );
      });
    });
  }
}

async function initializeAgentLog(
  logPath: string | undefined,
  command: string,
  args: string[],
  timeoutMs: number,
  idleTimeoutMs: number,
): Promise<void> {
  if (!logPath) return;

  await writeFile(
    logPath,
    [
      "# agent raw stream log",
      `command=${command}`,
      `args=${JSON.stringify(args.slice(0, -1))}`,
      `timeoutMs=${timeoutMs}`,
      `idleTimeoutMs=${idleTimeoutMs}`,
      "",
      "## stdout",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function appendAgentLog(logPath: string | undefined, chunk: Buffer | string): Promise<void> {
  if (!logPath) return;
  await appendFile(logPath, typeof chunk === "string" ? chunk : chunk.toString("utf8"), "utf8");
}

async function finalizeAgentLog(
  logPath: string | undefined,
  result: AgentRunResult,
  progress?: { lastActivity: string; toolCallsStarted: number; toolCallsCompleted: number; sessionId?: string },
): Promise<void> {
  if (!logPath) return;

  await appendFile(
    logPath,
    [
      "",
      "## harness",
      `exitCode=${result.exitCode}`,
      `timedOut=${result.timedOut}`,
      `durationMs=${result.durationMs}`,
      `signal=${result.signal ?? "null"}`,
      `stdoutBytes=${result.stdout.length}`,
      `stderrBytes=${result.stderr.length}`,
      progress ? `lastActivity=${progress.lastActivity}` : "",
      progress ? `toolCallsStarted=${progress.toolCallsStarted}` : "",
      progress ? `toolCallsCompleted=${progress.toolCallsCompleted}` : "",
      progress?.sessionId ? `sessionId=${progress.sessionId}` : "",
      "",
    ].join("\n"),
    "utf8",
  );
}

function buildArgs(
  configArgs: string[],
  input: { prompt: string; workspacePath: string },
  _role?: "generator" | "validator",
): string[] {
  // Keep --force for validators: headless Cursor rejects non-readonly MCP tool
  // calls (e.g. browser_navigate) without it. Edit isolation is prompt-enforced.
  const replaced = configArgs.map(arg =>
    arg
      .replaceAll(WORKSPACE_PLACEHOLDER, input.workspacePath)
      .replaceAll(PROMPT_PLACEHOLDER, input.prompt),
  );
  const hasPromptPlaceholder = configArgs.some(arg => arg.includes(PROMPT_PLACEHOLDER));
  return hasPromptPlaceholder ? replaced : [...replaced, input.prompt];
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
