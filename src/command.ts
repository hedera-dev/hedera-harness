import { spawn, type ChildProcess } from "node:child_process";
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
/** Grace period between SIGTERM and SIGKILL when a command overruns its timeout. */
const KILL_GRACE_MS = 5_000;
/** Retained bytes per stream. Output beyond this keeps the head and the tail. */
const CAPTURE_HEAD_BYTES = 256 * 1024;
const CAPTURE_TAIL_BYTES = 768 * 1024;

/**
 * Bounded capture of a child stream.
 *
 * Agents and dev servers can emit hundreds of megabytes over a long timeout.
 * The head keeps the startup context and the tail keeps whatever failed (or,
 * for agents, the final JSON verdict), while the middle is dropped so a long
 * run cannot exhaust memory.
 */
export class BoundedOutput {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private droppedBytes = 0;

  constructor(
    private readonly headLimit = CAPTURE_HEAD_BYTES,
    private readonly tailLimit = CAPTURE_TAIL_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let rest = chunk;

    if (this.headBytes < this.headLimit) {
      const room = this.headLimit - this.headBytes;
      if (rest.length <= room) {
        this.head.push(rest);
        this.headBytes += rest.length;
        return;
      }
      this.head.push(rest.subarray(0, room));
      this.headBytes += room;
      rest = rest.subarray(room);
    }

    this.tail.push(rest);
    this.tailBytes += rest.length;

    while (this.tail.length > 1 && this.tailBytes > this.tailLimit) {
      const dropped = this.tail.shift()!;
      this.tailBytes -= dropped.length;
      this.droppedBytes += dropped.length;
    }
  }

  get truncatedBytes(): number {
    return this.droppedBytes;
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.droppedBytes === 0) {
      return head + tail;
    }
    return `${head}\n...[hedera-harness] omitted ${this.droppedBytes} bytes of output...\n${tail}`;
  }
}

/**
 * Signal a child and everything it spawned.
 *
 * Commands run through a shell, so the direct child is `sh`; signalling only
 * that leaves yarn/next/hardhat running. Children are spawned detached (POSIX)
 * so they lead their own process group and a negative PID reaches the tree.
 */
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone, or never created — fall back to the direct child.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

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
      // Lead a new process group so the timeout can tear down grandchildren.
      detached: process.platform !== "win32",
    });

    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let timedOut = false;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      // A child that ignores SIGTERM would otherwise hang this promise forever.
      hardKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);

    const clearTimers = (): void => {
      clearTimeout(timeout);
      clearTimeout(hardKillTimer);
    };

    child.stdout.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stdout.push(buffer);
      if (streamOutput) {
        process.stdout.write(buffer);
      }
    });

    child.stderr.on("data", chunk => {
      const buffer = Buffer.from(chunk);
      stderr.push(buffer);
      if (streamOutput) {
        process.stderr.write(buffer);
      }
    });

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();

      resolve({
        command: options.command,
        args,
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
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
