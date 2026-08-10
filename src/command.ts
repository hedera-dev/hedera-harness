import { spawn } from "node:child_process";
import type { CommandExecutionResult } from "./types.js";

export interface ExecuteCommandOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  shell?: boolean;
  /**
   * When true, tee child stdout/stderr to the parent process while still
   * capturing buffers for result inspection / error messages.
   */
  streamOutput?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function executeCommand(options: ExecuteCommandOptions): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const streamOutput = options.streamOutput === true;

  return new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      shell: options.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stdoutChunks.push(buffer);
      if (streamOutput) {
        process.stdout.write(buffer);
      }
    });

    child.stderr.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stderrChunks.push(buffer);
      if (streamOutput) {
        process.stderr.write(buffer);
      }
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      resolve({
        command: options.command,
        args,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        durationMs: Date.now() - startedAt,
        timedOut,
        signal,
      });
    });
  });
}

export async function executeCommandOrThrow(options: ExecuteCommandOptions): Promise<CommandExecutionResult> {
  const result = await executeCommand(options);

  if (result.exitCode !== 0) {
    throw new Error(formatFailedCommand(result));
  }

  return result;
}

function formatFailedCommand(result: CommandExecutionResult): string {
  const renderedCommand = [result.command, ...result.args].join(" ");
  const reason = result.timedOut ? "timed out" : `exited with code ${result.exitCode}`;
  const stderr = result.stderr.trim();

  return stderr ? `Command "${renderedCommand}" ${reason}: ${stderr}` : `Command "${renderedCommand}" ${reason}.`;
}
