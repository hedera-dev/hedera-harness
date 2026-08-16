/**
 * Optional peer dependencies used only by higher validation gates.
 * Gate 0–1 consumers should not need to install these (~hundreds of MB).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fsUtils.js";

export type PackageInstallTool = "yarn" | "npm" | "pnpm";

export interface OptionalDepInstallOptions {
  /** Consumer project root used for lockfile / packageManager detection. */
  projectRoot?: string;
  /** Spec hint such as `yarn@3.2.3` from `constraints.packageManager`. */
  packageManager?: string;
}

/**
 * Pick yarn / npm / pnpm for install hints.
 * Prefers an explicit packageManager hint, then package.json#packageManager,
 * then lockfiles under projectRoot (default: process.cwd()).
 */
export async function resolvePackageInstallTool(
  options: OptionalDepInstallOptions = {},
): Promise<PackageInstallTool> {
  const fromHint = toolFromPackageManagerField(options.packageManager);
  if (fromHint) return fromHint;

  const root = options.projectRoot ?? process.cwd();
  try {
    const pkgRaw = await readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { packageManager?: unknown };
    const fromPkg = toolFromPackageManagerField(
      typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    );
    if (fromPkg) return fromPkg;
  } catch {
    // ignore missing / invalid package.json
  }

  if (await pathExists(path.join(root, "yarn.lock"))) return "yarn";
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await pathExists(path.join(root, "package-lock.json"))) return "npm";
  return "npm";
}

export function buildOptionalDepInstallLines(
  packageName: string,
  tool: PackageInstallTool,
): string[] {
  if (tool === "yarn") return [`yarn add -D ${packageName}`];
  if (tool === "pnpm") return [`pnpm add -D ${packageName}`];
  return [`npm install -D ${packageName}`];
}

export async function importPlaywright(
  options: OptionalDepInstallOptions = {},
): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      await formatOptionalDepError("playwright", "Tier 2 Playwright gate", options, error),
    );
  }
}

export async function importHieroSdk(
  options: OptionalDepInstallOptions = {},
): Promise<typeof import("@hiero-ledger/sdk")> {
  try {
    return await import("@hiero-ledger/sdk");
  } catch (error) {
    throw new Error(
      await formatOptionalDepError(
        "@hiero-ledger/sdk",
        "Tier 3.5 on-chain validation",
        options,
        error,
      ),
    );
  }
}

export async function formatOptionalDepError(
  packageName: string,
  feature: string,
  options: OptionalDepInstallOptions,
  error: unknown,
): Promise<string> {
  const tool = await resolvePackageInstallTool(options);
  const installLines = buildOptionalDepInstallLines(packageName, tool);
  const underlying = error instanceof Error ? error.message : String(error);
  return [
    `${feature} requires the optional peer dependency "${packageName}".`,
    "Install it at the project root that depends on hedera-harness (not only inside a workspace package):",
    ...installLines.map(line => `  ${line}`),
    `Underlying error: ${underlying}`,
  ].join("\n");
}

function toolFromPackageManagerField(value: string | undefined): PackageInstallTool | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("yarn")) return "yarn";
  if (trimmed.startsWith("pnpm")) return "pnpm";
  if (trimmed.startsWith("npm")) return "npm";
  return undefined;
}
