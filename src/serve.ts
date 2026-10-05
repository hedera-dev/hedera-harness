import { spawn } from "node:child_process";
import { join } from "node:path";
import { type Command, describe, killGroup, trackChild, untrackChild } from "./commands.js";

/** How long a dev server gets to answer, and how often we ask. */
const READY_TIMEOUT_MS = 2 * 60_000;
const POLL_INTERVAL_MS = 250;

/** Matches the URL a dev server prints, whatever prose surrounds it. */
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s)\]]*/;

export class ServeError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "ServeError";
  }
}

export interface Server {
  /** The URL the server printed, normalised to something fetchable. */
  readonly url: string;
  /** Combined output so far — the whole of it if the server never became ready. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Starts the dev server and waits until it actually answers.
 *
 * The URL is read from the server's own output rather than declared in
 * `harness.yaml`, so it cannot drift from reality: a project that moves to
 * another port reports the new one, and the harness follows.
 */
export async function startServer(
  command: Command,
  repoRoot: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<Server> {
  const cwd = command.cwd ? join(repoRoot, command.cwd) : repoRoot;
  const child = spawn(command.run, {
    cwd,
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  trackChild(child.pid);
  let output = "";
  let exited: number | null = null;
  const collect = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    output += String(error);
  });
  child.on("close", (code) => {
    exited = code ?? 0;
    untrackChild(child.pid);
  });

  const stop = async (): Promise<void> => {
    untrackChild(child.pid);
    killGroup(child.pid);
    await new Promise<void>((resolve) => {
      if (exited !== null) return resolve();
      child.once("close", () => resolve());
      setTimeout(resolve, 5_000).unref();
    });
  };

  const deadline = Date.now() + timeoutMs;
  let url: string | null = null;

  while (Date.now() < deadline) {
    if (exited !== null && url === null) {
      throw new ServeError(
        `${describe(command)} exited (code ${exited}) before printing a URL`,
        output,
      );
    }
    url ??= fetchableUrl(output);
    if (url !== null && (await answers(url))) {
      return { url, output: () => output, stop };
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await stop();
  throw new ServeError(
    url === null
      ? `${describe(command)} printed no local URL within ${timeoutMs / 1000}s`
      : `${url} did not answer within ${timeoutMs / 1000}s`,
    output,
  );
}

/** `0.0.0.0` is what servers bind to and not reliably what clients can reach. */
function fetchableUrl(output: string): string | null {
  const match = URL_PATTERN.exec(output);
  if (match === null) return null;
  return match[0].replace("0.0.0.0", "127.0.0.1").replace(/\/+$/, "");
}

/** Any HTTP response means the server is up. A 404 is still an answer. */
async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
