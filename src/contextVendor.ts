import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ISOLATED_CONTEXT_DIR } from "./runtimePaths.js";

export const HARNESS_CONTEXT_DIR = ISOLATED_CONTEXT_DIR;
export const VENDORED_PRD_PATH = `${HARNESS_CONTEXT_DIR}/prd.md`;
export const VENDORED_CONTRACT_PATH = `${HARNESS_CONTEXT_DIR}/acceptance-contract.json`;

/** Playwright MCP config merged into the seeded workspace so the validator agent can drive the live app. */
export const PLAYWRIGHT_MCP_SERVER = {
  command: "npx",
  args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chromium"],
} as const;

export interface VendoredContext {
  prdRelativePath: string;
  contractRelativePath?: string;
  prdSourcePath: string;
  contractSourcePath?: string;
  playwrightMcpPath?: string;
}

export interface VendorContextOptions {
  /** Relative directory under the workspace (default: `.harness-context`). */
  contextDir?: string;
  /**
   * When false, skip mutating `.cursor/mcp.json` (extend uses snapshot/restore around validation).
   * Default: true.
   */
  injectPlaywrightMcp?: boolean;
}

export async function vendorHarnessContext(
  workspacePath: string,
  input: { prdPath: string; contractPath?: string },
  options: VendorContextOptions = {},
): Promise<VendoredContext> {
  const contextDir = normalizeRelativeDir(options.contextDir ?? HARNESS_CONTEXT_DIR);
  const contextRoot = path.join(workspacePath, ...contextDir.split("/"));
  await mkdir(contextRoot, { recursive: true });

  const prdContent = await readFile(input.prdPath, "utf8");
  const prdRelativePath = path.posix.join(contextDir, "prd.md");
  await writeFile(path.join(workspacePath, ...prdRelativePath.split("/")), prdContent, "utf8");

  let contractRelativePath: string | undefined;
  if (input.contractPath) {
    const contractContent = await readFile(input.contractPath, "utf8");
    contractRelativePath = path.posix.join(contextDir, "acceptance-contract.json");
    await writeFile(
      path.join(workspacePath, ...contractRelativePath.split("/")),
      contractContent,
      "utf8",
    );
  }

  const injectPlaywrightMcp = options.injectPlaywrightMcp !== false;
  const playwrightMcpPath = injectPlaywrightMcp
    ? await ensurePlaywrightMcp(workspacePath)
    : undefined;

  await writeFile(
    path.join(contextRoot, "manifest.json"),
    `${JSON.stringify(
      {
        vendoredAt: new Date().toISOString(),
        prd: {
          relativePath: prdRelativePath,
          sourcePath: input.prdPath,
        },
        contract: contractRelativePath
          ? {
              relativePath: contractRelativePath,
              sourcePath: input.contractPath,
            }
          : undefined,
        playwrightMcp: playwrightMcpPath
          ? {
              relativePath: playwrightMcpPath,
            }
          : undefined,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    prdRelativePath,
    contractRelativePath,
    prdSourcePath: input.prdPath,
    contractSourcePath: input.contractPath,
    playwrightMcpPath,
  };
}

/**
 * Merge the Playwright MCP server into the workspace `.cursor/mcp.json`.
 * The Cursor agent CLI loads MCP from the `--workspace` directory, so the
 * seeded scaffold config alone is not enough for semantic validation.
 */
export async function ensurePlaywrightMcp(workspacePath: string): Promise<string> {
  const relativePath = ".cursor/mcp.json";
  const mcpPath = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(mcpPath), { recursive: true });

  let existing: { mcpServers?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(await readFile(mcpPath, "utf8")) as typeof existing;
  } catch {
    existing = {};
  }

  const mcpServers = { ...(existing.mcpServers ?? {}) };
  mcpServers.playwright = { ...PLAYWRIGHT_MCP_SERVER };

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
 * Temporarily inject Playwright MCP into `.cursor/mcp.json`, then restore the
 * prior file (or remove the file if it did not exist). Used by in-place extend
 * so the final branch does not contain harness-injected MCP changes.
 */
export async function withPlaywrightMcpSnapshot<T>(
  workspacePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const mcpPath = path.join(workspacePath, ".cursor", "mcp.json");
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
    await ensurePlaywrightMcp(workspacePath);
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

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativeDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
