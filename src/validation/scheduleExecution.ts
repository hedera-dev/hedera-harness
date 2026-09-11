import type { ValidationFinding } from "../types.js";

export const TESTNET_MIRROR_NODE_URL = "https://testnet.mirrornode.hedera.com";

/** How long CHAIN waits for a schedule to execute and for the mirror node to index it. */
export const DEFAULT_SCHEDULE_TIMEOUT_MS = 120_000;

/**
 * A deploy command hands the harness a schedule to prove by printing one of these
 * lines, e.g. `HARNESS_SCHEDULE_ID=0.0.10457462`. Whitespace around the line is
 * ignored so an indented `console.log` from a Foundry or Hardhat script qualifies.
 */
const SCHEDULE_ID_LINE = /^\s*HARNESS_SCHEDULE_ID=(\d+\.\d+\.\d+)\s*$/gm;

export function parseScheduleIds(output: string): string[] {
  return [...new Set([...output.matchAll(SCHEDULE_ID_LINE)].map(match => match[1]))];
}

export interface ScheduleExecutionOptions {
  /** Injectable so tests never reach the network. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type ScheduleExecutionFailureReason =
  | "not-found"
  | "deleted"
  | "not-executed"
  | "child-missing"
  | "failed"
  | "mirror-node";

export interface ScheduleExecuted {
  ok: true;
  scheduleId: string;
  executedTimestamp: string;
  /** Mirror-node id of the scheduled transaction (`0.0.x-sss-nnn`). */
  transactionId: string;
}

export interface ScheduleExecutionFailure {
  ok: false;
  scheduleId: string;
  reason: ScheduleExecutionFailureReason;
  /** Mirror-node `result` of the scheduled transaction when it ran and did not succeed. */
  result?: string;
  detail: string;
}

export type ScheduleExecutionVerdict = ScheduleExecuted | ScheduleExecutionFailure;

interface MirrorSchedule {
  deleted?: boolean;
  executed_timestamp?: string | null;
  expiration_time?: string | null;
}

interface MirrorTransactionPage {
  transactions?: Array<{
    transaction_id?: string;
    result?: string;
    scheduled?: boolean;
  }>;
}

class MirrorNodeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/**
 * Prove a scheduled transaction executed and succeeded.
 *
 * `GET /api/v1/schedules/{id}` sets `executed_timestamp` whether the inner
 * transaction succeeded or reverted, so that field alone proves nothing. The
 * scheduled transaction is the `scheduled: true` entry at that consensus
 * timestamp — `GET /api/v1/transactions?timestamp={executed_timestamp}` — and
 * its `result` decides. Looking it up by transaction id instead is wrong: a
 * scheduled call that schedules its successor reuses the id, and the id lookup
 * returns only the first child.
 *
 * Waits, bounded by `timeoutMs`, for mirror lag, for the schedule to reach its
 * expiry, and for the child to be indexed. `deleted` is only fatal before
 * execution: a scheduled call may delete its own schedule after running.
 */
export async function verifyScheduleExecution(
  scheduleId: string,
  options: ScheduleExecutionOptions = {},
): Promise<ScheduleExecutionVerdict> {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? TESTNET_MIRROR_NODE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCHEDULE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;

  const fail = (
    reason: ScheduleExecutionFailureReason,
    detail: string,
    result?: string,
  ): ScheduleExecutionFailure => ({
    ok: false,
    scheduleId,
    reason,
    detail,
    ...(result === undefined ? {} : { result }),
  });

  let executedTimestamp: string | undefined;
  // Why we are still waiting; becomes the verdict when the budget runs out.
  let pending = fail("not-found", "not visible on the mirror node");

  for (;;) {
    try {
      if (executedTimestamp === undefined) {
        const schedule = await readJson<MirrorSchedule>(
          fetchImpl,
          `${baseUrl}/api/v1/schedules/${scheduleId}`,
        );
        if (!schedule) {
          pending = fail("not-found", "GET /api/v1/schedules/{id} answered 404");
        } else if (schedule.executed_timestamp) {
          executedTimestamp = schedule.executed_timestamp;
        } else if (schedule.deleted) {
          return fail("deleted", "deleted before it executed");
        } else {
          pending = fail(
            "not-executed",
            `executed_timestamp is still null (expiration_time ${schedule.expiration_time ?? "unknown"})`,
          );
        }
      }

      if (executedTimestamp !== undefined) {
        const page = await readJson<MirrorTransactionPage>(
          fetchImpl,
          `${baseUrl}/api/v1/transactions?timestamp=${executedTimestamp}`,
        );
        const child = page?.transactions?.find(transaction => transaction.scheduled === true);
        if (child) {
          const transactionId = child.transaction_id ?? "unknown";
          if (child.result === "SUCCESS") {
            return { ok: true, scheduleId, executedTimestamp, transactionId };
          }
          const result = child.result ?? "UNKNOWN";
          return fail(
            "failed",
            `executed at ${executedTimestamp}; scheduled transaction ${transactionId} ended with ${result}`,
            result,
          );
        }
        pending = fail(
          "child-missing",
          `executed at ${executedTimestamp} but no scheduled transaction is indexed at that timestamp`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof MirrorNodeError && !error.retryable) {
        return fail("mirror-node", message);
      }
      pending = fail("mirror-node", message);
    }

    if (Date.now() >= deadline) {
      return { ...pending, detail: `${pending.detail} after ${timeoutMs / 1000}s` };
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * One finding per schedule that was not proven executed and successful.
 * Schedules are checked concurrently; the wait budget applies to each.
 */
export async function verifyScheduledTransactions(
  scheduleIds: string[],
  options: ScheduleExecutionOptions = {},
): Promise<ValidationFinding[]> {
  const verdicts = await Promise.all(
    scheduleIds.map(scheduleId => verifyScheduleExecution(scheduleId, options)),
  );
  const findings: ValidationFinding[] = [];

  for (const verdict of verdicts) {
    if (verdict.ok) {
      console.log(
        `[hedera-harness] Schedule ${verdict.scheduleId} executed at ${verdict.executedTimestamp}: ${verdict.transactionId} SUCCESS`,
      );
      continue;
    }
    findings.push({
      id: `chain-schedule:${verdict.scheduleId}`,
      category: "commands",
      message:
        verdict.reason === "failed"
          ? `Scheduled transaction ${verdict.scheduleId} executed but its transaction failed: ${verdict.result}`
          : `Scheduled transaction ${verdict.scheduleId} was not proven executed (${verdict.reason})`,
      details: verdict.detail,
    });
  }

  return findings;
}

/** 200 → body, 404 → undefined. 5xx, 429 and transport errors retry; other 4xx do not. */
async function readJson<T>(fetchImpl: typeof fetch, url: string): Promise<T | undefined> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new MirrorNodeError(
      `${url}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new MirrorNodeError(
      `${url}: HTTP ${response.status}`,
      response.status >= 500 || response.status === 429,
    );
  }
  return (await response.json()) as T;
}
