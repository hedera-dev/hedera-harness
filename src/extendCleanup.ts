import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PLAYWRIGHT_MCP_SERVER } from "./contextVendor.js";
import { listExtendConsumerDirtyPaths } from "./extendGit.js";
import { EXTEND_RUNTIME_DIR } from "./runtimePaths.js";

export interface ExtendCleanupResult {
  removedPaths: string[];
  mcpStripped: boolean;
  consumerDirtyPaths: string[];
  treeClean: boolean;
}

const REMOVABLE_RUNTIME_DIRS = [
  EXTEND_RUNTIME_DIR,
  ".harness-skills",
  ".harness-context",
  ".skill-cache",
] as const;

/**
 * Remove ignored runtime/vendor injections and strip harness Playwright MCP
 * from `.cursor/mcp.json` if still present. Does not delete `.harness/runs/`
 * (reports/session must remain). Never switches branches or touches remotes.
 */
export async function cleanupExtendRuntimeInjections(
  workspacePath: string,
): Promise<ExtendCleanupResult> {
  const removedPaths: string[] = [];

  for (const relativeDir of REMOVABLE_RUNTIME_DIRS) {
    const absolute = path.join(workspacePath, ...relativeDir.split("/"));
    if (await exists(absolute)) {
      await rm(absolute, { recursive: true, force: true });
      removedPaths.push(relativeDir);
    }
  }

  const mcpStripped = await stripHarnessPlaywrightMcp(workspacePath);

  // Remove ephemeral chain signer material under any run directory (ignored).
  const runsRoot = path.join(workspacePath, ".harness", "runs");
  if (await exists(runsRoot)) {
    try {
      const entries = await readdir(runsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const signerPath = path.join(runsRoot, entry.name, "chain-signer.json");
        if (await exists(signerPath)) {
          await rm(signerPath, { force: true });
          removedPaths.push(path.posix.join(".harness/runs", entry.name, "chain-signer.json"));
        }
      }
    } catch {
      // ignore
    }
  }

  const consumerDirtyPaths = await listExtendConsumerDirtyPaths(workspacePath);
  return {
    removedPaths,
    mcpStripped,
    consumerDirtyPaths,
    treeClean: consumerDirtyPaths.length === 0,
  };
}

async function stripHarnessPlaywrightMcp(workspacePath: string): Promise<boolean> {
  const mcpPath = path.join(workspacePath, ".cursor", "mcp.json");
  if (!(await exists(mcpPath))) {
    return false;
  }

  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(await readFile(mcpPath, "utf8")) as typeof parsed;
  } catch {
    return false;
  }

  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== "object" || !("playwright" in servers)) {
    return false;
  }

  const playwright = servers.playwright as { command?: string; args?: string[] };
  const looksLikeHarness =
    playwright?.command === PLAYWRIGHT_MCP_SERVER.command &&
    Array.isArray(playwright.args) &&
    playwright.args.join(" ") === PLAYWRIGHT_MCP_SERVER.args.join(" ");

  if (!looksLikeHarness) {
    return false;
  }

  const nextServers = { ...servers };
  delete nextServers.playwright;

  if (Object.keys(nextServers).length === 0) {
    await rm(mcpPath, { force: true });
    return true;
  }

  await writeFile(
    mcpPath,
    `${JSON.stringify(
      {
        ...parsed,
        mcpServers: nextServers,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return true;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
