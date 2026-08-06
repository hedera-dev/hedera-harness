import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../fsUtils.js";

const FINGERPRINT_FILES = ["yarn.lock", "package.json"] as const;

export async function computeInstallFingerprint(workspacePath: string): Promise<string> {
  const relativePaths: string[] = [];

  for (const relativePath of FINGERPRINT_FILES) {
    if (await pathExists(path.join(workspacePath, relativePath))) {
      relativePaths.push(relativePath);
    }
  }

  const packagesDir = path.join(workspacePath, "packages");
  try {
    const entries = await readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const relativePath = path.join("packages", entry.name, "package.json");
      if (await pathExists(path.join(workspacePath, relativePath))) {
        relativePaths.push(relativePath);
      }
    }
  } catch {
    // no packages workspace
  }

  const hash = createHash("sha256");
  for (const relativePath of relativePaths.sort()) {
    const content = await readFile(path.join(workspacePath, relativePath));
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
  }

  return hash.digest("hex");
}

export async function readCachedInstallFingerprint(cachePath: string): Promise<string | undefined> {
  try {
    const value = (await readFile(cachePath, "utf8")).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export async function writeCachedInstallFingerprint(cachePath: string, fingerprint: string): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${fingerprint}\n`, "utf8");
}
