import { appendFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { BoundedOutput, killProcessTree } from "../command.js";
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
    });
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
        // Lead a new process group so timeouts tear down agent subprocesses.
        detached: process.platform !== "win32",
      });

      // The verdict JSON arrives at the end of the stream, so the tail is the
      // part that must survive truncation on a very chatty run.
      const stdout = new BoundedOutput(256 * 1024, 3 * 1024 * 1024);
      const stderr = new BoundedOutput(128 * 1024, 512 * 1024);
      let timedOut = false;
      let idleTimedOut = false;
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;
      let hardKillTimer: NodeJS.Timeout | undefined;

      void initializeAgentLog(
        input.logPath,
        this.config.command,
        redactPromptArgs(args, input.prompt),
        timeoutMs,
        idleTimeoutMs,
      );
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
        killProcessTree(child, "SIGTERM");
        hardKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 5_000);
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
        stdout.push(buffer);
        const text = buffer.toString("utf8");
        void appendAgentLog(input.logPath, buffer);
        void streamLogger?.processChunk(text);
      });

      child.stderr.on("data", chunk => {
        resetIdleTimer();
        const buffer = Buffer.from(chunk);
        stderr.push(buffer);
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
          stdout: stdout.toString(),
          stderr: [
            stderr.toString(),
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

/**
 * Replace the prompt wherever it appears in argv.
 *
 * Prompts can carry the ephemeral chain signer's private key, so they must
 * never reach the log. Slicing off the last argument only worked when the
 * prompt was appended; configs using the {prompt} placeholder put it in the
 * middle, which logged the key verbatim and dropped an unrelated flag.
 */
function redactPromptArgs(args: string[], prompt: string): string[] {
  return args.map(arg => (arg.includes(prompt) ? "<prompt redacted>" : arg));
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
      `args=${JSON.stringify(args)}`,
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
