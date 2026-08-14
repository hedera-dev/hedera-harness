import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativeDir } from "./fsUtils.js";
import { resolveMcpBrowser } from "./mcpBrowser.js";
import { ISOLATED_CONTEXT_DIR } from "./runtimePaths.js";

export { pathExists } from "./fsUtils.js";

/**
 * Legacy vendor root, used by `validate-semantic` against older layouts.
 *
 * Deliberately NOT named HARNESS_CONTEXT_DIR: runtimePaths exports a constant by
 * that name pointing at `.harness/runtime/context`, where a project run actually
 * vendors. Two same-named constants with different values previously let repair
 * prompts fall back to a directory the run never creates.
 */
export const LEGACY_CONTEXT_DIR = ISOLATED_CONTEXT_DIR;
export const VENDORED_PRD_PATH = `${LEGACY_CONTEXT_DIR}/prd.md`;
export const VENDORED_CONTRACT_PATH = `${LEGACY_CONTEXT_DIR}/acceptance-contract.json`;

/**
 * Playwright MCP server the validator agent drives the live app through.
 *
 * The browser is resolved per project rather than fixed: see `mcpBrowser.ts`.
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
  const contextDir = normalizeRelativeDir(options.contextDir ?? LEGACY_CONTEXT_DIR);
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
export async function ensurePlaywrightMcp(
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
