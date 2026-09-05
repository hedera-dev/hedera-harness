import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PersistentWallet } from "../types.js";
import {
  HARNESS_WALLET_EXTENSION_ID,
  HARNESS_WALLET_NAME,
  REOWN_PROJECT_ID_ENV,
} from "./constants.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function extensionSourceDir(): string {
  return path.join(PACKAGE_ROOT, "extension");
}

export interface ExtensionRuntimeConfig {
  runtimeBaseUrl: string;
  accountId: string;
  network: "testnet";
  extensionId: string;
  extensionName: string;
  projectId?: string;
}

/**
 * Copy the unpacked extension into a temp directory and write runtime-config.json.
 * Secrets never go into extension source — only the runtime URL + public account id.
 */
export async function materializeExtension(options: {
  targetDir: string;
  runtimeBaseUrl: string;
  wallet: PersistentWallet;
  projectId?: string;
}): Promise<{ extensionDir: string; configPath: string }> {
  const extensionDir = path.join(options.targetDir, "harness-test-wallet");
  await mkdir(extensionDir, { recursive: true });
  await cp(extensionSourceDir(), extensionDir, { recursive: true });

  const config: ExtensionRuntimeConfig = {
    runtimeBaseUrl: options.runtimeBaseUrl,
    accountId: options.wallet.accountId,
    network: "testnet",
    extensionId: HARNESS_WALLET_EXTENSION_ID,
    extensionName: HARNESS_WALLET_NAME,
    projectId: options.projectId ?? process.env[REOWN_PROJECT_ID_ENV],
  };

  const configPath = path.join(extensionDir, "runtime-config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // Ensure manifest name matches discovery metadata.
  const manifestPath = path.join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.name = HARNESS_WALLET_NAME;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { extensionDir, configPath };
}
