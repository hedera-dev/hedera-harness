import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, LaunchOptions } from "playwright";
import { importPlaywright } from "./optionalDeps.js";

/**
 * Pinned, not `@latest`.
 *
 * `@latest` moved the required browser build under users with no harness
 * release: 0.0.79 (2026-08-06) bumped its bundled Playwright and started
 * demanding a chromium revision nobody had downloaded, which failed a run only
 * after the generator had already been paid for.
 */
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.79";

/** Marks a server entry as harness-written, so cleanup never strips a user's own. */
export const HARNESS_MCP_MARKER = "--headless";

export type McpBrowserSource = "project-playwright" | "system-chrome";

interface McpBrowserChoiceBase {
  args: string[];
  /** One line for logs and doctor output. */
  detail: string;
}

export type McpBrowserChoice =
  | (McpBrowserChoiceBase & {
      source: "project-playwright";
      /** Absolute browser path supplied by the project's Playwright package. */
      executablePath: string;
    })
  | (McpBrowserChoiceBase & {
      source: "system-chrome";
      executablePath?: undefined;
    });

export function mcpArgsForBrowser(
  choice:
    | { source: "project-playwright"; executablePath: string }
    | { source: "system-chrome"; executablePath?: undefined },
): string[] {
  const base = ["-y", PLAYWRIGHT_MCP_PACKAGE, HARNESS_MCP_MARKER];
  if (choice.source === "project-playwright") {
    // `chromium` is Playwright's engine name, not a documented value for the
    // MCP CLI's --browser channel flag. The existing executable is sufficient.
    return [...base, "--executable-path", choice.executablePath];
  }
  return [...base, "--browser", "chrome"];
}

export function playwrightLaunchOptionsForBrowser(
  choice:
    | { source: "project-playwright"; executablePath: string }
    | { source: "system-chrome"; executablePath?: undefined },
): LaunchOptions {
  if (choice.source === "project-playwright") {
    return { headless: true, executablePath: choice.executablePath };
  }
  return { headless: true, channel: "chrome" };
}

/**
 * Choose the browser the EVALUATE validator drives.
 *
 * Preference is Playwright Chromium when that binary is already on disk —
 * the same one the SMOKE gate uses. That keeps both stages on one browser
 * (a route that renders for the gate renders for the evaluator).
 *
 * The fallback is the system Chrome channel, which needs no download either but
 * is whatever version the machine happens to have. A host should not
 * `yarn add playwright`; the Node API ships with the harness.
 */
export async function resolveMcpBrowser(projectRoot: string): Promise<McpBrowserChoice> {
  try {
    const { chromium } = await importPlaywright({ projectRoot });
    const executablePath = chromium.executablePath();
    await access(executablePath);
    return {
      args: mcpArgsForBrowser({ source: "project-playwright", executablePath }),
      source: "project-playwright",
      executablePath,
      detail: `Playwright Chromium (shared with the SMOKE gate) — ${executablePath}`,
    };
  } catch {
    // Playwright API present but no downloaded Chromium, or import failed.
    return {
      args: mcpArgsForBrowser({ source: "system-chrome" }),
      source: "system-chrome",
      detail:
        "system Chrome — shared by SMOKE and EVALUATE because Playwright Chromium was unavailable",
    };
  }
}

/** Launch the exact browser choice shared with the EVALUATE MCP server. */
export async function launchSharedBrowser(projectRoot: string): Promise<Browser> {
  const [{ chromium }, choice] = await Promise.all([
    importPlaywright({ projectRoot }),
    resolveMcpBrowser(projectRoot),
  ]);
  return chromium.launch(playwrightLaunchOptionsForBrowser(choice));
}

/** true = navigated, false = launch failed, undefined = still unknown. */
function verdictFrom(output: string): boolean | undefined {
  if (/is not installed|Executable doesn't exist|expected executable at|Failed to launch/i.test(output)) {
    return false;
  }
  if (/about:blank|Page URL|Ran Playwright code/i.test(output)) {
    return true;
  }
  return undefined;
}

export interface McpBrowserProbe {
  ok: boolean;
  choice: McpBrowserChoice;
  /** Launch error as reported by the MCP server, when the probe failed. */
  error?: string;
}

/**
 * Start the MCP server and actually navigate, because every cheaper check has
 * lied. A dry-run reported "installed" for a browser the validator could not
 * launch, and the failure then surfaced as ten semantic findings after a paid
 * agent session rather than as a missing prerequisite.
 */
export async function probeMcpBrowser(
  projectRoot: string,
  timeoutMs = 60_000,
): Promise<McpBrowserProbe> {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");

  const choice = await resolveMcpBrowser(projectRoot);
  // The server writes session files into `.playwright-mcp/` under its cwd.
  // Left in the project those dirty the working tree, which the next run
  // refuses to start on — a preflight must not cost the user a clean tree.
  const outputDir = await mkdtemp(nodePath.join(os.tmpdir(), "harness-mcp-probe-"));

  return await new Promise<McpBrowserProbe>(resolve => {
    const child = spawn("npx", [...choice.args, "--output-dir", outputDir], {
      cwd: outputDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      // Settle as soon as the answer is known. Waiting for the timeout put a
      // full minute in front of every EVALUATE run.
      if (verdictFrom(output) !== undefined) finish();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const send = (message: unknown) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        // The server may already be gone; the timeout path reports it.
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      void rm(outputDir, { recursive: true, force: true });

      if (verdictFrom(output) === true) {
        resolve({ ok: true, choice });
        return;
      }

      const error =
        output.match(/Browser "[^"]+" is not installed[^\n]*/)?.[0] ??
        output.match(/Executable doesn't exist[^\n]*/)?.[0] ??
        output.match(/Failed to launch[^\n]*/)?.[0] ??
        output.trim().split("\n").slice(-3).join(" ").slice(0, 300) ??
        "no response from the Playwright MCP server";
      resolve({ ok: false, choice, error });
    };

    const timer = setTimeout(finish, timeoutMs);
    child.on("error", finish);
    child.on("exit", () => setTimeout(finish, 200));

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hedera-harness-doctor", version: "1" },
      },
    });

    setTimeout(() => {
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "browser_navigate", arguments: { url: "about:blank" } },
      });
    }, 1_500);
  });
}

/** True when a `.mcp.json` entry looks like one the harness wrote. */
export function isHarnessMcpServer(server: unknown): boolean {
  if (!server || typeof server !== "object") return false;
  const { command, args } = server as { command?: unknown; args?: unknown };
  if (command !== "npx" || !Array.isArray(args)) return false;
  // Both must be present: a user writing `@playwright/mcp@<pin>` by hand is
  // plausible, but not together with the harness marker flag.
  return args.includes(PLAYWRIGHT_MCP_PACKAGE) && args.includes(HARNESS_MCP_MARKER);
}

/**
 * Playwright MCP server the validator agent drives the live app through.
 *
 * The browser is resolved per project rather than fixed: see `resolveMcpBrowser`.
 */
export async function playwrightMcpServer(
  projectRoot: string,
  outputDir?: string,
): Promise<{ command: string; args: string[] }> {
  const browser = await resolveMcpBrowser(projectRoot);
  // Without --output-dir the server drops `.playwright-mcp/` session files into
  // the workspace, leaving a dirty tree that the next run refuses to start on.
  const args = outputDir ? [...browser.args, "--output-dir", outputDir] : browser.args;
  return { command: "npx", args };
}

/** Standalone MCP config the harness owns, for CLIs that accept a config path. */
export async function writePlaywrightMcpConfig(
  absolutePath: string,
  projectRoot: string,
): Promise<string> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  // Session files land beside the config, inside the harness-owned run dir.
  const outputDir = path.join(path.dirname(absolutePath), "output");
  await mkdir(outputDir, { recursive: true });
  const server = await playwrightMcpServer(projectRoot, outputDir);
  await writeFile(
    absolutePath,
    `${JSON.stringify({ mcpServers: { playwright: server } }, null, 2)}\n`,
    "utf8",
  );
  return absolutePath;
}

/**
 * Merge the Playwright MCP server into a workspace config file.
 *
 * For CLIs with no flag to point elsewhere (Cursor), the harness has to write
 * into the project, which is why the caller restores it afterwards.
 */
async function ensurePlaywrightMcp(
  workspacePath: string,
  relativePath = ".cursor/mcp.json",
  outputDir?: string,
): Promise<string> {
  const mcpPath = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(mcpPath), { recursive: true });

  let existing: { mcpServers?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(await readFile(mcpPath, "utf8")) as typeof existing;
  } catch {
    existing = {};
  }

  const mcpServers = { ...(existing.mcpServers ?? {}) };
  mcpServers.playwright = await playwrightMcpServer(workspacePath, outputDir);

  await writeFile(
    mcpPath,
    `${JSON.stringify(
      {
        ...existing,
        mcpServers,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return relativePath;
}

/**
 * Temporarily inject Playwright MCP into a workspace config, then restore the
 * prior file (or remove it if it did not exist), so the branch does not end up
 * carrying harness-injected MCP changes.
 */
export async function withPlaywrightMcpSnapshot<T>(
  workspacePath: string,
  relativePath: string,
  fn: () => Promise<T>,
  outputDir?: string,
): Promise<T> {
  const mcpPath = path.join(workspacePath, ...relativePath.split("/"));
  let previous: string | undefined;
  let existed = false;
  try {
    previous = await readFile(mcpPath, "utf8");
    existed = true;
  } catch {
    previous = undefined;
    existed = false;
  }

  try {
    await ensurePlaywrightMcp(workspacePath, relativePath, outputDir);
    return await fn();
  } finally {
    if (existed && previous !== undefined) {
      await mkdir(path.dirname(mcpPath), { recursive: true });
      await writeFile(mcpPath, previous, "utf8");
    } else {
      try {
        await unlink(mcpPath);
      } catch {
        // absent is fine
      }
    }
  }
}
