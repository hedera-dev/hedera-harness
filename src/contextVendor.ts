import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativeDir } from "./fsUtils.js";
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

export interface VendoredContext {
  prdRelativePath: string;
  contractRelativePath?: string;
  prdSourcePath: string;
  contractSourcePath?: string;
}

export interface VendorContextOptions {
  /** Relative directory under the workspace (default: `.harness-context`). */
  contextDir?: string;
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
  };
}
