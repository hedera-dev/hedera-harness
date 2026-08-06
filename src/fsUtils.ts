import { access } from "node:fs/promises";

/** True when `targetPath` exists and is accessible. */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a relative directory path for posix joins (strip `./`, trailing `/`). */
export function normalizeRelativeDir(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}
