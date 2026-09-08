import { DEFAULT_LOCAL_CHAIN } from "../specDefaults.js";
import type { ChainValidationConfig } from "../types.js";

/** Opaque id returned by `evm_snapshot`. */
export type ChainSnapshotId = string;

async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`${method}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) {
    throw new Error(`${method}: ${body.error.message ?? "rpc error"}`);
  }
  return body.result;
}

function rpcUrl(config: ChainValidationConfig): string {
  return config.local?.rpcUrl ?? DEFAULT_LOCAL_CHAIN.rpcUrl;
}

/**
 * Take a snapshot of the chain before an attempt runs.
 *
 * Returns undefined on testnet (nothing to snapshot) and on a local node that does not
 * implement `evm_snapshot`. The caller logs that and carries on without isolation.
 */
export async function takeChainSnapshot(
  config: ChainValidationConfig,
): Promise<ChainSnapshotId | undefined> {
  if (config.network !== "local") return undefined;
  const result = await rpc(rpcUrl(config), "evm_snapshot");
  return typeof result === "string" ? result : undefined;
}

/**
 * Put the chain back to `id`. Returns false if the node refused, which means the next attempt
 * starts on whatever the failed one left behind.
 */
export async function revertChainSnapshot(
  config: ChainValidationConfig,
  id: ChainSnapshotId,
): Promise<boolean> {
  if (config.network !== "local") return false;
  return (await rpc(rpcUrl(config), "evm_revert", [id])) === true;
}
