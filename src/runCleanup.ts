import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isHarnessMcpServer } from "./mcpBrowser.js";
import { listHarnessConsumerDirtyPaths } from "./harnessGit.js";
import { HARNESS_RUNTIME_DIR } from "./runtimePaths.js";

export interface CleanupResult {
  removedPaths: string[];
  mcpStripped: boolean;
  consumerDirtyPaths: string[];
  treeClean: boolean;
}

const REMOVABLE_RUNTIME_DIRS = [
  HARNESS_RUNTIME_DIR,
  ".harness-skills",
  ".harness-context",
  ".skill-cache",
] as const;

/**
 * Remove ignored runtime/vendor injections and strip harness Playwright MCP
 * from `.cursor/mcp.json` if still present. Does not delete `.harness/runs/`
 * (reports/session must remain). Never switches branches or touches remotes.
 */
export async function cleanupRuntimeInjections(
  workspacePath: string,
): Promise<CleanupResult> {
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

  const consumerDirtyPaths = await listHarnessConsumerDirtyPaths(workspacePath);
  return {
    removedPaths,
    mcpStripped,
    consumerDirtyPaths,
    treeClean: consumerDirtyPaths.length === 0,
  };
}

/** Workspace MCP files any agent preset may write. Claude is passed a config path instead. */
const WORKSPACE_MCP_PATHS = [[".cursor", "mcp.json"], [".mcp.json"]] as const;

async function stripHarnessPlaywrightMcp(workspacePath: string): Promise<boolean> {
  let stripped = false;
  for (const segments of WORKSPACE_MCP_PATHS) {
    if (await stripMcpFile(path.join(workspacePath, ...segments))) stripped = true;
  }
  return stripped;
}

async function stripMcpFile(mcpPath: string): Promise<boolean> {
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

  // Match on a marker rather than the exact arg list: the browser flags are
  // resolved per project now, so an equality check would stop recognising our
  // own entry — and, worse, could start matching a user's if the two ever
  // converged. Never strip a server the harness did not write.
  if (!isHarnessMcpServer(servers.playwright)) {
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
