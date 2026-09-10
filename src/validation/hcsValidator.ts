import { GENESIS_RUNNING_HASH, SUPPORTED_RUNNING_HASH_VERSION, nextRunningHash } from "../runningHash.js";

const DEFAULT_MIRROR_BASE_URL = "https://testnet.mirrornode.hedera.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_PAGE_SIZE = 100;

export interface HcsValidationConfig {
  topicIdEnv: string;
  expectMessagesMatching?: string;
  minMessages?: number;
  verifyRunningHashChain?: boolean;
  expectDenseSequence?: {
    field: string;
    groupBy?: string;
  };
  sinceConsensusTimestamp?: string;
  mirrorBaseUrl?: string;
  timeoutMs?: number;
}

export interface HcsValidationResult {
  status: "pass" | "fail" | "pending";
  topicId: string;
  messagesFound: number;
  messagesMatched: number;
  chainVerified: boolean | null;
  brokeAtSequenceNumber: number | null;
  missingSequenceValues: number[] | null;
  problems: string[];
  detail: string;
}

interface MirrorMessage {
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
  running_hash: string;
  running_hash_version: number;
  sequence_number: number;
}

const isRegexLiteral = (s: string): boolean => s.length > 2 && s.startsWith("/") && s.lastIndexOf("/") > 0;

function buildMatcher(pattern: string | undefined): (decoded: string) => boolean {
  if (!pattern) return () => true;
  if (isRegexLiteral(pattern)) {
    const lastSlash = pattern.lastIndexOf("/");
    const body = pattern.slice(1, lastSlash);
    const flags = pattern.slice(lastSlash + 1);
    let re: RegExp;
    try {
      re = new RegExp(body, flags);
    } catch (error) {
      throw new Error(
        `chainValidation.hcs.expectMessagesMatching is not a valid regex: ${pattern} (${(error as Error).message})`,
      );
    }
    return (decoded) => re.test(decoded);
  }
  return (decoded) => decoded.includes(pattern);
}

async function fetchTopicMessages(topicId: string, mirrorBaseUrl: string): Promise<MirrorMessage[]> {
  const out: MirrorMessage[] = [];
  let url: string | null =
    `${mirrorBaseUrl}/api/v1/topics/${topicId}/messages?limit=${MAX_PAGE_SIZE}&order=asc`;

  while (url) {
    const response = await fetch(url);
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`mirror node returned ${response.status} for ${url}`);
    const page = (await response.json()) as { messages?: MirrorMessage[]; links?: { next?: string | null } };
    out.push(...(page.messages ?? []));
    const next = page.links?.next;
    url = next ? new URL(next, mirrorBaseUrl).toString() : null;
  }
  return out;
}

export function verifyRunningHashChain(
  topicId: string,
  messages: MirrorMessage[],
): { ok: boolean; brokeAt: number | null; reason?: string } {
  let previous = GENESIS_RUNNING_HASH;
  let expectedSequence: number | null = null;

  for (const message of messages) {
    if (expectedSequence !== null && message.sequence_number !== expectedSequence) {
      return {
        ok: false,
        brokeAt: message.sequence_number,
        reason: `sequence gap: expected ${expectedSequence}, got ${message.sequence_number}`,
      };
    }

    if (message.running_hash_version !== SUPPORTED_RUNNING_HASH_VERSION) {
      return {
        ok: false,
        brokeAt: message.sequence_number,
        reason: `unsupported running_hash_version ${message.running_hash_version} (this validator implements v${SUPPORTED_RUNNING_HASH_VERSION})`,
      };
    }

    const computed = nextRunningHash({
      prevRunningHash: previous,
      version: message.running_hash_version,
      payerAccountId: message.payer_account_id,
      topicId,
      consensusTimestamp: message.consensus_timestamp,
      sequenceNumber: message.sequence_number,
      messageBytes: Buffer.from(message.message, "base64"),
    });

    const actual = Buffer.from(message.running_hash, "base64");
    if (!computed.equals(actual)) {
      return { ok: false, brokeAt: message.sequence_number, reason: "running hash mismatch" };
    }

    previous = actual;
    expectedSequence = message.sequence_number + 1;
  }

  return { ok: true, brokeAt: null };
}

export function findSequenceGaps(
  decoded: string[],
  field: string,
  groupBy?: string,
): { missing: number[]; unparsed: number; duplicated: boolean } {
  const byIssuer = new Map<string, number[]>();
  let unparsed = 0;

  for (const body of decoded) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      unparsed++;
      continue;
    }

    const raw = parsed[field];
    const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isInteger(value)) {
      unparsed++;
      continue;
    }

    const issuer = groupBy && typeof parsed[groupBy] === "string" ? String(parsed[groupBy]) : "";
    const list = byIssuer.get(issuer) ?? [];
    list.push(value);
    byIssuer.set(issuer, list);
  }

  const missing: number[] = [];
  let duplicated = false;

  for (const values of byIssuer.values()) {
    const present = new Set(values);
    if (present.size !== values.length) duplicated = true;
    const lowest = Math.min(...values);
    const highest = Math.max(...values);
    for (let n = lowest; n <= highest; n++) if (!present.has(n)) missing.push(n);
  }

  return { missing: [...new Set(missing)].sort((a, b) => a - b), unparsed, duplicated };
}

export async function validateHcsTopic(
  topicId: string,
  config: HcsValidationConfig,
): Promise<HcsValidationResult> {
  const mirrorBaseUrl = config.mirrorBaseUrl ?? DEFAULT_MIRROR_BASE_URL;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minMessages = config.minMessages ?? 1;
  const matches = buildMatcher(config.expectMessagesMatching);
  const problems: string[] = [];

  const base: HcsValidationResult = {
    status: "pending",
    topicId,
    messagesFound: 0,
    messagesMatched: 0,
    chainVerified: null,
    brokeAtSequenceNumber: null,
    missingSequenceValues: null,
    problems,
    detail: "",
  };

  if (!/^\d+\.\d+\.\d+$/.test(topicId)) {
    return {
      ...base,
      status: "fail",
      problems: [`topic id ${JSON.stringify(topicId)} is not a valid Hedera entity id (shard.realm.num)`],
      detail: "invalid topic id",
    };
  }

  const deadline = Date.now() + timeoutMs;
  let messages: MirrorMessage[] = [];

  while (Date.now() < deadline) {
    try {
      messages = await fetchTopicMessages(topicId, mirrorBaseUrl);
    } catch (error) {
      problems.push(`mirror node error: ${(error as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
      continue;
    }

    const inWindow = config.sinceConsensusTimestamp
      ? messages.filter((m) => m.consensus_timestamp >= config.sinceConsensusTimestamp!)
      : messages;

    const matched = inWindow.filter((m) => matches(Buffer.from(m.message, "base64").toString("utf8")));

    if (matched.length >= minMessages) {
      const result: HcsValidationResult = {
        ...base,
        messagesFound: messages.length,
        messagesMatched: matched.length,
        problems: [],
        status: "pass",
        detail: `${matched.length} matching message(s) on topic ${topicId}`,
      };

      if (config.verifyRunningHashChain) {
        const chain = verifyRunningHashChain(topicId, messages);
        result.chainVerified = chain.ok;
        result.brokeAtSequenceNumber = chain.brokeAt;
        if (!chain.ok) {
          return {
            ...result,
            status: "fail",
            problems: [
              `running hash chain broken at sequence number ${chain.brokeAt}: ${chain.reason}. ` +
                `A message was inserted, removed, reordered, or altered.`,
            ],
            detail: `chain broken at seq ${chain.brokeAt}`,
          };
        }
        result.detail += `, running hash chain intact across ${messages.length} message(s)`;
      }

      if (config.expectDenseSequence) {
        const { field, groupBy } = config.expectDenseSequence;
        const decoded = matched.map((m) => Buffer.from(m.message, "base64").toString("utf8"));
        const gaps = findSequenceGaps(decoded, field, groupBy);
        result.missingSequenceValues = gaps.missing;

        if (gaps.duplicated) {
          return {
            ...result,
            status: "fail",
            problems: [
              `two messages from one issuer share the same \`${field}\` value. ` +
                `That is renumbering, not suppression, and it makes the sequence unusable as evidence.`,
            ],
            detail: `duplicate ${field} value`,
          };
        }

        if (gaps.missing.length > 0) {
          return {
            ...result,
            status: "fail",
            problems: [
              `\`${field}\` is not dense: ${gaps.missing.join(", ")} absent from the range observed. ` +
                `The running hash chain is intact, so nothing was deleted — those records were never written. ` +
                `NOTE: a record still in flight looks identical to one withheld, so re-run once the agent has settled.`,
            ],
            detail: `${gaps.missing.length} missing ${field} value(s)`,
          };
        }

        result.detail +=
          `, \`${field}\` dense across ${decoded.length - gaps.unparsed} numbered message(s)`;
      }

      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
  }

  return {
    ...base,
    status: "fail",
    messagesFound: messages.length,
    messagesMatched: 0,
    problems: [
      messages.length === 0
        ? `topic ${topicId} has no messages after ${timeoutMs}ms. The agent may not have submitted, or the topic id is wrong.`
        : `topic ${topicId} has ${messages.length} message(s) but none matched ${JSON.stringify(config.expectMessagesMatching)} after ${timeoutMs}ms.`,
    ],
    detail: `timed out after ${timeoutMs}ms`,
  };
}