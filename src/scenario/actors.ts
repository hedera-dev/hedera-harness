import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { importHieroSdk } from "../optionalDeps.js";
import type { ChainValidationOperatorConfig } from "../types.js";
import { readOperatorCredentials } from "./operator.js";
import type { ScenarioActor, ScenarioActorSpec } from "./types.js";

export const SCENARIO_ACTORS_FILENAME = "scenario-actors.json";

export function scenarioActorsPath(runDirectory: string): string {
  return path.join(runDirectory, SCENARIO_ACTORS_FILENAME);
}

export async function provisionScenarioActors(
  actors: Record<string, ScenarioActorSpec>,
  operator: ChainValidationOperatorConfig,
  runDirectory: string,
): Promise<{ actors: ScenarioActor[]; reused: boolean }> {
  const persistPath = scenarioActorsPath(runDirectory);
  const existing = await readPersistedActors(persistPath);
  if (existing && namesMatch(existing, actors)) {
    return { actors: existing, reused: true };
  }

  const sdk = await importHieroSdk();
  const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(operator);
  const client = sdk.Client.forTestnet();
  client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);

  const created: ScenarioActor[] = [];
  try {
    for (const [name, spec] of Object.entries(actors)) {
      const key = sdk.PrivateKey.generateECDSA();
      const receipt = await (
        await new sdk.AccountCreateTransaction()
          .setECDSAKeyWithAlias(key)
          .setInitialBalance(new sdk.Hbar(spec.fundHbar))
          .execute(client)
      ).getReceipt(client);
      const accountId = receipt.accountId?.toString();
      if (!accountId) {
        throw new Error(`AccountCreateTransaction for actor ${name} did not return an account ID.`);
      }
      created.push({
        name,
        accountId,
        privateKeyHex: key.toStringRaw().replace(/^0x/i, ""),
        evmAddress: `0x${key.publicKey.toEvmAddress()}`,
      });
    }
  } finally {
    client.close();
  }

  await writeFile(persistPath, `${JSON.stringify(created, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { actors: created, reused: false };
}

export async function sweepScenarioActors(
  actors: ScenarioActor[],
  operator: ChainValidationOperatorConfig,
  runDirectory: string,
  sweepBack: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (!sweepBack) return { success: true };
  try {
    const sdk = await importHieroSdk();
    const { accountId: operatorId, privateKey: operatorKey } = await readOperatorCredentials(operator);
    const client = sdk.Client.forTestnet();
    client.setOperator(sdk.AccountId.fromString(operatorId), operatorKey);
    try {
      for (const actor of [...actors].reverse()) {
        const ephemeralKey = sdk.PrivateKey.fromStringECDSA(actor.privateKeyHex.replace(/^0x/i, ""));
        const frozen = await new sdk.AccountDeleteTransaction()
          .setAccountId(sdk.AccountId.fromString(actor.accountId))
          .setTransferAccountId(sdk.AccountId.fromString(operatorId))
          .freezeWith(client);
        const signed = await frozen.sign(ephemeralKey);
        await (await signed.execute(client)).getReceipt(client);
      }
    } finally {
      client.close();
    }
    await unlink(scenarioActorsPath(runDirectory)).catch(() => undefined);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readPersistedActors(persistPath: string): Promise<ScenarioActor[] | undefined> {
  try {
    await access(persistPath);
  } catch {
    return undefined;
  }
  const parsed = JSON.parse(await readFile(persistPath, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  return parsed as ScenarioActor[];
}

function namesMatch(existing: ScenarioActor[], wanted: Record<string, ScenarioActorSpec>): boolean {
  const have = existing.map(actor => actor.name).sort();
  const need = Object.keys(wanted).sort();
  return have.length === need.length && have.every((name, index) => name === need[index]);
}
