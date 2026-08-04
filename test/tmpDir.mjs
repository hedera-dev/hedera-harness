import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Create a unique temp directory under the repo's gitignored `.tmp-test/`.
 * Ensures the parent exists (required on fresh CI checkouts).
 */
export async function makeTestTempDir(prefix) {
  const parent = path.join(process.cwd(), ".tmp-test");
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, prefix));
}

/** System temp dir when the fixture does not need to live under the repo. */
export async function makeOsTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
