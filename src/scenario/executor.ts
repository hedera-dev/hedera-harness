import { importHieroSdk } from "../optionalDeps.js";
import {
  fetchJson,
  parseAccountHbar,
  parsePendingAirdrop,
  parseTokenBalance,
  parseTopicContains,
  pollUntil,
} from "./mirror.js";
import type {
  ScenarioActor,
  ScenarioAssertion,
  ScenarioAssertionResult,
  ScenarioBindings,
  ScenarioPlan,
  ScenarioRunResult,
  ScenarioStep,
  ScenarioStepResult,
} from "./types.js";

type HieroSdk = typeof import("@hiero-ledger/sdk");
type Client = ReturnType<HieroSdk["Client"]["forTestnet"]>;

export async function executeScenarioPlan(
  plan: ScenarioPlan,
  actors: ScenarioActor[],
): Promise<ScenarioRunResult> {
  const started = Date.now();
  const byName = new Map(actors.map(actor => [actor.name, actor]));
  const bindings: ScenarioBindings = {};
  for (const actor of actors) {
    bindings[actor.name] = { accountId: actor.accountId };
  }

  const sdk = await importHieroSdk();
  const steps: ScenarioStepResult[] = [];

  for (const step of plan.steps) {
    const actor = byName.get(step.actor);
    if (!actor) {
      return fail(`Unknown actor ${step.actor}`, steps, bindings, started);
    }
    const stepStarted = Date.now();
    const client = sdk.Client.forTestnet();
    client.setOperator(
      sdk.AccountId.fromString(actor.accountId),
      sdk.PrivateKey.fromStringECDSA(actor.privateKeyHex.replace(/^0x/i, "")),
    );
    try {
      const result = await runStep(sdk, client, step, actor, bindings, byName);
      steps.push({ ...result, durationMs: Date.now() - stepStarted });
      bindings[step.id] = {
        ...bindings[step.id],
        accountId: result.accountId ?? bindings[step.id]?.accountId,
        tokenId: result.tokenId,
        topicId: result.topicId,
        transactionId: result.transactionId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({
        id: step.id,
        kind: stepKind(step),
        actor: step.actor,
        durationMs: Date.now() - stepStarted,
        error: message,
      });
      return {
        passed: false,
        infrastructureFailure: isInfraError(message),
        infrastructureFailureReason: isInfraError(message) ? message : undefined,
        steps,
        assertions: [],
        bindings,
        durationMs: Date.now() - started,
      };
    } finally {
      client.close();
    }
  }

  const assertions: ScenarioAssertionResult[] = [];
  for (const assertion of plan.assertions) {
    try {
      assertions.push(await runAssertion(assertion, byName, bindings));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assertions.push({
        kind: assertionKind(assertion),
        passed: false,
        detail: message,
      });
    }
  }

  return {
    passed: assertions.every(item => item.passed) && steps.every(item => !item.error),
    steps,
    assertions,
    bindings,
    durationMs: Date.now() - started,
  };
}

async function runStep(
  sdk: HieroSdk,
  client: Client,
  step: ScenarioStep,
  actor: ScenarioActor,
  bindings: ScenarioBindings,
  byName: Map<string, ScenarioActor>,
): Promise<Omit<ScenarioStepResult, "durationMs"> & { accountId?: string }> {
  if ("transferHbar" in step) {
    const to = resolveAccount(step.transferHbar.to, byName, bindings);
    const amount = new sdk.Hbar(step.transferHbar.hbar);
    const tx = await new sdk.TransferTransaction()
      .addHbarTransfer(sdk.AccountId.fromString(actor.accountId), amount.negated())
      .addHbarTransfer(sdk.AccountId.fromString(to), amount)
      .execute(client);
    await tx.getReceipt(client);
    return { id: step.id, kind: "transferHbar", actor: step.actor, transactionId: tx.transactionId.toString() };
  }

  if ("tokenCreate" in step) {
    const tx = await new sdk.TokenCreateTransaction()
      .setTokenName(step.tokenCreate.name)
      .setTokenSymbol(step.tokenCreate.symbol)
      .setDecimals(step.tokenCreate.decimals ?? 0)
      .setInitialSupply(step.tokenCreate.initialSupply ?? 0)
      .setTreasuryAccountId(sdk.AccountId.fromString(actor.accountId))
      .setAdminKey(sdk.PrivateKey.fromStringECDSA(actor.privateKeyHex.replace(/^0x/i, "")))
      .execute(client);
    const receipt = await tx.getReceipt(client);
    const tokenId = receipt.tokenId?.toString();
    if (!tokenId) throw new Error(`tokenCreate ${step.id} did not return a token ID.`);
    return {
      id: step.id,
      kind: "tokenCreate",
      actor: step.actor,
      transactionId: tx.transactionId.toString(),
      tokenId,
    };
  }

  if ("tokenAssociate" in step) {
    const tokenId = resolveToken(step.tokenAssociate.token, bindings);
    const tx = await new sdk.TokenAssociateTransaction()
      .setAccountId(sdk.AccountId.fromString(actor.accountId))
      .setTokenIds([sdk.TokenId.fromString(tokenId)])
      .execute(client);
    await tx.getReceipt(client);
    return { id: step.id, kind: "tokenAssociate", actor: step.actor, transactionId: tx.transactionId.toString(), tokenId };
  }

  if ("tokenAirdrop" in step) {
    const tokenId = resolveToken(step.tokenAirdrop.token, bindings);
    const to = resolveAccount(step.tokenAirdrop.to, byName, bindings);
    const amount = step.tokenAirdrop.amount;
    const tx = await new sdk.TokenAirdropTransaction()
      .addTokenTransfer(sdk.TokenId.fromString(tokenId), sdk.AccountId.fromString(actor.accountId), -amount)
      .addTokenTransfer(sdk.TokenId.fromString(tokenId), sdk.AccountId.fromString(to), amount)
      .execute(client);
    await tx.getReceipt(client);
    return { id: step.id, kind: "tokenAirdrop", actor: step.actor, transactionId: tx.transactionId.toString(), tokenId };
  }

  if ("tokenClaim" in step) {
    const tokenId = resolveToken(step.tokenClaim.token, bindings);
    const pending = await pollUntil(`pending airdrop ${tokenId} for ${actor.accountId}`, async () => {
      const json = await fetchJson(`/api/v1/accounts/${actor.accountId}/airdrops/pending`);
      return parsePendingAirdrop(json, tokenId);
    });
    const tx = await new sdk.TokenClaimAirdropTransaction()
      .addPendingAirdropId(
        new sdk.PendingAirdropId({
          senderId: pending.senderId,
          receiverId: actor.accountId,
          tokenId,
        }),
      )
      .execute(client);
    await tx.getReceipt(client);
    return { id: step.id, kind: "tokenClaim", actor: step.actor, transactionId: tx.transactionId.toString(), tokenId };
  }

  if ("topicCreate" in step) {
    const tx = await new sdk.TopicCreateTransaction().execute(client);
    const receipt = await tx.getReceipt(client);
    const topicId = receipt.topicId?.toString();
    if (!topicId) throw new Error(`topicCreate ${step.id} did not return a topic ID.`);
    return {
      id: step.id,
      kind: "topicCreate",
      actor: step.actor,
      transactionId: tx.transactionId.toString(),
      topicId,
    };
  }

  const topicId = resolveTopic(step.topicSubmit.topic, bindings);
  const tx = await new sdk.TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(step.topicSubmit.message)
    .execute(client);
  await tx.getReceipt(client);
  return { id: step.id, kind: "topicSubmit", actor: step.actor, transactionId: tx.transactionId.toString(), topicId };
}

async function runAssertion(
  assertion: ScenarioAssertion,
  byName: Map<string, ScenarioActor>,
  bindings: ScenarioBindings,
): Promise<ScenarioAssertionResult> {
  if ("accountHbar" in assertion) {
    const actor = byName.get(assertion.accountHbar.actor);
    if (!actor) throw new Error(`Unknown actor ${assertion.accountHbar.actor}`);
    const hbar = await pollUntil(`HBAR balance for ${actor.accountId}`, async () => {
      const json = await fetchJson(`/api/v1/accounts/${actor.accountId}`);
      const amount = parseAccountHbar(json);
      return amount >= assertion.accountHbar.min ? amount : undefined;
    });
    return {
      kind: "accountHbar",
      passed: true,
      detail: `${actor.name} has ${hbar} HBAR (min ${assertion.accountHbar.min})`,
    };
  }

  if ("tokenBalance" in assertion) {
    const actor = byName.get(assertion.tokenBalance.actor);
    if (!actor) throw new Error(`Unknown actor ${assertion.tokenBalance.actor}`);
    const tokenId = resolveToken(assertion.tokenBalance.token, bindings);
    const balance = await pollUntil(`token ${tokenId} balance for ${actor.accountId}`, async () => {
      const json = await fetchJson(`/api/v1/accounts/${actor.accountId}/tokens`);
      const amount = parseTokenBalance(json, tokenId);
      return amount >= assertion.tokenBalance.min ? amount : undefined;
    });
    return {
      kind: "tokenBalance",
      passed: true,
      detail: `${actor.name} holds ${balance} of ${tokenId} (min ${assertion.tokenBalance.min})`,
    };
  }

  const topicId = resolveTopic(assertion.topicMessage.topic, bindings);
  await pollUntil(`topic ${topicId} contains ${JSON.stringify(assertion.topicMessage.contains)}`, async () => {
    const json = await fetchJson(`/api/v1/topics/${topicId}/messages?order=desc&limit=10`);
    return parseTopicContains(json, assertion.topicMessage.contains) ? true : undefined;
  });
  return {
    kind: "topicMessage",
    passed: true,
    detail: `topic ${topicId} contains ${JSON.stringify(assertion.topicMessage.contains)}`,
  };
}

function resolveAccount(
  nameOrId: string,
  byName: Map<string, ScenarioActor>,
  bindings: ScenarioBindings,
): string {
  if (/^\d+\.\d+\.\d+$/.test(nameOrId)) return nameOrId;
  const actor = byName.get(nameOrId);
  if (actor) return actor.accountId;
  const bound = bindings[nameOrId]?.accountId;
  if (bound) return bound;
  throw new Error(`Cannot resolve account ${JSON.stringify(nameOrId)}.`);
}

function resolveToken(nameOrId: string, bindings: ScenarioBindings): string {
  if (/^\d+\.\d+\.\d+$/.test(nameOrId)) return nameOrId;
  const bound = bindings[nameOrId]?.tokenId;
  if (bound) return bound;
  throw new Error(`Cannot resolve token ${JSON.stringify(nameOrId)} — use a tokenCreate step id.`);
}

function resolveTopic(nameOrId: string, bindings: ScenarioBindings): string {
  if (/^\d+\.\d+\.\d+$/.test(nameOrId)) return nameOrId;
  const bound = bindings[nameOrId]?.topicId;
  if (bound) return bound;
  throw new Error(`Cannot resolve topic ${JSON.stringify(nameOrId)} — use a topicCreate step id.`);
}

function stepKind(step: ScenarioStep): string {
  if ("transferHbar" in step) return "transferHbar";
  if ("tokenCreate" in step) return "tokenCreate";
  if ("tokenAssociate" in step) return "tokenAssociate";
  if ("tokenAirdrop" in step) return "tokenAirdrop";
  if ("tokenClaim" in step) return "tokenClaim";
  if ("topicCreate" in step) return "topicCreate";
  return "topicSubmit";
}

function assertionKind(assertion: ScenarioAssertion): string {
  if ("accountHbar" in assertion) return "accountHbar";
  if ("tokenBalance" in assertion) return "tokenBalance";
  return "topicMessage";
}

function isInfraError(message: string): boolean {
  return /Mirror request failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|503|502/i.test(message);
}

function fail(
  message: string,
  steps: ScenarioStepResult[],
  bindings: ScenarioBindings,
  started: number,
): ScenarioRunResult {
  return {
    passed: false,
    steps,
    assertions: [{ kind: "plan", passed: false, detail: message }],
    bindings,
    durationMs: Date.now() - started,
  };
}
