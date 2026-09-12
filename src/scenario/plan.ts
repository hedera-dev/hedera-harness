import type { ScenarioAssertion, ScenarioPlan, ScenarioStep } from "./types.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function parseScenarioPlan(raw: unknown, origin: string): ScenarioPlan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected a scenario object in ${origin}.`);
  }
  const record = raw as Record<string, unknown>;
  const actors = readActors(record.actors, origin);
  const steps = readSteps(record.steps, origin, new Set(Object.keys(actors)));
  const assertions = readAssertions(record.assert ?? record.assertions ?? [], origin);
  return { actors, steps, assertions };
}

function readActors(raw: unknown, origin: string): ScenarioPlan["actors"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Expected object "actors" in ${origin}.`);
  }
  const actors: ScenarioPlan["actors"] = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) {
      throw new Error(`Actor name ${JSON.stringify(name)} in ${origin} must match ${NAME_RE}.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Expected object actors.${name} in ${origin}.`);
    }
    const fundHbar = (value as { fundHbar?: unknown }).fundHbar;
    const amount = typeof fundHbar === "number" ? fundHbar : 5;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`actors.${name}.fundHbar must be a positive number in ${origin}.`);
    }
    actors[name] = { fundHbar: amount };
  }
  if (Object.keys(actors).length === 0) {
    throw new Error(`scenarios need at least one actor in ${origin}.`);
  }
  return actors;
}

function readSteps(raw: unknown, origin: string, actorNames: Set<string>): ScenarioStep[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Expected a non-empty "steps" list in ${origin}.`);
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Expected object at steps[${index}] in ${origin}.`);
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" && NAME_RE.test(record.id) ? record.id : `step-${index + 1}`;
    if (seen.has(id)) {
      throw new Error(`Duplicate step id ${JSON.stringify(id)} in ${origin}.`);
    }
    seen.add(id);
    const actor = typeof record.actor === "string" ? record.actor : "";
    if (!actorNames.has(actor)) {
      throw new Error(`steps[${index}] actor ${JSON.stringify(record.actor)} is not in actors in ${origin}.`);
    }
    const step = readStepBody(id, actor, record, origin, index);
    return step;
  });
}

function readStepBody(
  id: string,
  actor: string,
  record: Record<string, unknown>,
  origin: string,
  index: number,
): ScenarioStep {
  if (record.transferHbar) {
    const body = asObject(record.transferHbar, `steps[${index}].transferHbar`, origin);
    return { id, actor, transferHbar: { to: readName(body, "to"), hbar: readPositive(body, "hbar") } };
  }
  if (record.tokenCreate) {
    const body = asObject(record.tokenCreate, `steps[${index}].tokenCreate`, origin);
    return {
      id,
      actor,
      tokenCreate: {
        name: readText(body, "name"),
        symbol: readText(body, "symbol"),
        decimals: optionalNumber(body, "decimals") ?? 0,
        initialSupply: optionalNumber(body, "initialSupply") ?? 0,
      },
    };
  }
  if (record.tokenAssociate) {
    const body = asObject(record.tokenAssociate, `steps[${index}].tokenAssociate`, origin);
    return { id, actor, tokenAssociate: { token: readName(body, "token") } };
  }
  if (record.tokenAirdrop) {
    const body = asObject(record.tokenAirdrop, `steps[${index}].tokenAirdrop`, origin);
    return {
      id,
      actor,
      tokenAirdrop: {
        token: readName(body, "token"),
        to: readName(body, "to"),
        amount: readPositive(body, "amount"),
      },
    };
  }
  if (record.tokenClaim) {
    const body = asObject(record.tokenClaim, `steps[${index}].tokenClaim`, origin);
    return { id, actor, tokenClaim: { token: readName(body, "token") } };
  }
  if (record.topicCreate !== undefined) {
    return { id, actor, topicCreate: {} };
  }
  if (record.topicSubmit) {
    const body = asObject(record.topicSubmit, `steps[${index}].topicSubmit`, origin);
    return { id, actor, topicSubmit: { topic: readName(body, "topic"), message: readText(body, "message") } };
  }
  throw new Error(
    `steps[${index}] in ${origin} must be one of transferHbar, tokenCreate, tokenAssociate, tokenAirdrop, tokenClaim, topicCreate, topicSubmit.`,
  );
}

function readAssertions(raw: unknown, origin: string): ScenarioAssertion[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Expected "assert" to be a list in ${origin}.`);
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Expected object at assert[${index}] in ${origin}.`);
    }
    const record = item as Record<string, unknown>;
    if (record.accountHbar) {
      const body = asObject(record.accountHbar, `assert[${index}].accountHbar`, origin);
      return { accountHbar: { actor: readName(body, "actor"), min: readNonNegative(body, "min") } };
    }
    if (record.tokenBalance) {
      const body = asObject(record.tokenBalance, `assert[${index}].tokenBalance`, origin);
      return {
        tokenBalance: {
          actor: readName(body, "actor"),
          token: readName(body, "token"),
          min: readNonNegative(body, "min"),
        },
      };
    }
    if (record.topicMessage) {
      const body = asObject(record.topicMessage, `assert[${index}].topicMessage`, origin);
      return { topicMessage: { topic: readName(body, "topic"), contains: readText(body, "contains") } };
    }
    throw new Error(
      `assert[${index}] in ${origin} must be accountHbar, tokenBalance, or topicMessage.`,
    );
  });
}

function asObject(value: unknown, label: string, origin: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object ${label} in ${origin}.`);
  }
  return value as Record<string, unknown>;
}

function readName(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty string "${key}".`);
  }
  return value.trim();
}

function readText(record: Record<string, unknown>, key: string): string {
  return readName(record, key);
}

function readPositive(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected positive number "${key}".`);
  }
  return value;
}

function readNonNegative(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Expected non-negative number "${key}".`);
  }
  return value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
