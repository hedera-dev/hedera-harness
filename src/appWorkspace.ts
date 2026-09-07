import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const VAULT_REL = [".harness", "wallet", "metamask-test.json"] as const;

/** Size-only check. Never read vault JSON (it holds the TESTNET key). */
export function vaultFileLooksPresent(workspaceDir: string): boolean {
  const file = path.join(path.resolve(workspaceDir), ...VAULT_REL);
  try {
    if (!existsSync(file)) return false;
    const st = statSync(file);
    return st.isFile() && st.size >= 80 && st.size <= 8192;
  } catch {
    return false;
  }
}

function packageName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

export function isHarnessAppWorkspace(dir: string): boolean {
  if (!existsSync(path.join(dir, ".harness", "spec.yaml"))) return false;
  return packageName(dir) !== "hedera-harness";
}

function isHarnessCliPackage(dir: string): boolean {
  return packageName(dir) === "hedera-harness" && existsSync(path.join(dir, "dist", "index.js"));
}

function preferTestApp(cliRoot: string): string | undefined {
  const nested = path.join(cliRoot, "test-app");
  if (vaultFileLooksPresent(nested) || isHarnessAppWorkspace(nested)) return nested;
  return undefined;
}

/**
 * OpenCode often starts in the hedera-harness CLI repo. Wallet vaults live in the
 * app (test-app), not in the CLI package. Never read vault contents.
 */
export function resolveAppWorkspace(startDir: string): string {
  const start = path.resolve(startDir);
  if (isHarnessAppWorkspace(start) || vaultFileLooksPresent(start)) return start;

  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (isHarnessCliPackage(dir)) break;
    if (isHarnessAppWorkspace(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (isHarnessCliPackage(start)) {
    const nested = preferTestApp(start);
    if (nested) return nested;
  }

  return start;
}
