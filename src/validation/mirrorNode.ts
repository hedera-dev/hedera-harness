/**
 * Mirror node reads for CHAIN validation.
 *
 * Tier 3.5 verifies effects "against the mirror node rather than UI toasts",
 * but the harness shipped no code for it, so every recipe and every validator
 * agent rediscovered the same three things by hand:
 *
 *  1. Entity endpoints answer 404 for a second or two after consensus and then
 *     200, so a single read straight after a receipt is a false negative.
 *  2. `/topics/{id}/messages` answers 200 with an empty list for a topic that
 *     does not exist, so it cannot tell a wrong id from mirror lag. Existence
 *     goes through `/topics/{id}`, which does answer 404.
 *  3. A transaction id has two forms. The SDK returns `0.0.x@sss.nnn`; the
 *     mirror node wants `0.0.x-sss-nnn` and answers HTTP 400 for the other.
 *
 * The waits here treat 404 (and a failed request) as "not yet" and any other
 * 4xx as a caller mistake that will never come right, so a bad URL fails fast
 * instead of burning the whole timeout.
 */

export type MirrorNetwork = "testnet" | "previewnet";

export const MIRROR_NODE_BASE_URLS: Record<MirrorNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com/api/v1",
  previewnet: "https://previewnet.mirrornode.hedera.com/api/v1",
};

/** Measured on testnet: entity endpoints trail consensus by ~1-3s. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;

export interface MirrorReadOptions {
  network?: MirrorNetwork;
  /** Overrides `network`; useful for a local mirror node. */
  baseUrl?: string;
  requestTimeoutMs?: number;
}

export interface MirrorWaitOptions extends MirrorReadOptions {
  timeoutMs?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Extra readiness test for endpoints that answer 200 before the data lands. */
  accept?: (body: unknown) => boolean;
}

export interface MirrorReadResult<T = unknown> {
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  ok: boolean;
  url: string;
  body?: T;
  /** Transport or parse failure. */
  error?: string;
}

export interface MirrorWaitResult<T = unknown> extends MirrorReadResult<T> {
  found: boolean;
  attempts: number;
  elapsedMs: number;
  /** Set when polling stopped early because waiting could not help. */
  stoppedEarly?: "client-error";
}

export function mirrorNodeBaseUrl(options: MirrorReadOptions = {}): string {
  const base = options.baseUrl ?? MIRROR_NODE_BASE_URLS[options.network ?? "testnet"];
  return base.replace(/\/+$/, "");
}

/**
 * Convert an SDK / UI transaction id (`0.0.x@sss.nnn`) into the form the mirror
 * node and HashScan accept (`0.0.x-sss-nnn`). Already-converted ids pass
 * through. Anything else throws rather than producing a URL that quietly reads
 * as "no such transaction".
 */
export function normalizeTransactionId(transactionId: string): string {
  const value = transactionId.trim();

  const sdkForm = value.match(/^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/);
  if (sdkForm) {
    return `${sdkForm[1]}-${sdkForm[2]}-${sdkForm[3]}`;
  }

  if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(value)) {
    return value;
  }

  throw new Error(
    `Not a Hedera transaction id: ${JSON.stringify(transactionId)}. ` +
      `Expected "0.0.x@sss.nnn" (SDK form) or "0.0.x-sss-nnn" (mirror node form).`,
  );
}

/** One read. A 404 is a value, not an error: absence is what callers wait on. */
export async function readMirrorNode<T = unknown>(
  resourcePath: string,
  options: MirrorReadOptions = {},
): Promise<MirrorReadResult<T>> {
  const url = `${mirrorNodeBaseUrl(options)}/${resourcePath.replace(/^\/+/, "")}`;

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });

    let body: T | undefined;
    try {
      body = (await response.json()) as T;
    } catch {
      body = undefined;
    }

    return { status: response.status, ok: response.ok, url, body };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read until the resource is there, the deadline passes, or the mirror node
 * says the request itself is wrong.
 */
export async function waitForMirrorNode<T = unknown>(
  resourcePath: string,
  options: MirrorWaitOptions = {},
): Promise<MirrorWaitResult<T>> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let delay = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  let attempts = 0;
  let last: MirrorReadResult<T>;

  for (;;) {
    attempts += 1;
    last = await readMirrorNode<T>(resourcePath, options);

    if (last.ok && (options.accept?.(last.body) ?? true)) {
      return { ...last, found: true, attempts, elapsedMs: Date.now() - startedAt };
    }

    // 400 on a malformed id, 422 on a bad filter: waiting cannot fix the URL.
    if (last.status >= 400 && last.status < 500 && last.status !== 404) {
      return {
        ...last,
        found: false,
        attempts,
        elapsedMs: Date.now() - startedAt,
        stoppedEarly: "client-error",
      };
    }

    if (Date.now() + delay >= deadline) {
      return { ...last, found: false, attempts, elapsedMs: Date.now() - startedAt };
    }

    await sleep(delay);
    delay = Math.min(delay * 2, maxDelay);
  }
}

/** Accepts an account id (`0.0.x`) or an EVM address, which the mirror resolves. */
export async function waitForAccount<T = unknown>(
  accountIdOrEvmAddress: string,
  options: MirrorWaitOptions = {},
): Promise<MirrorWaitResult<T>> {
  return waitForMirrorNode<T>(`accounts/${encodeURIComponent(accountIdOrEvmAddress)}`, options);
}

/** Normalizes the id first, so an id copied from an app UI still resolves. */
export async function waitForTransaction<T = unknown>(
  transactionId: string,
  options: MirrorWaitOptions = {},
): Promise<MirrorWaitResult<T>> {
  const normalized = normalizeTransactionId(transactionId);
  return waitForMirrorNode<T>(`transactions/${normalized}`, options);
}

/**
 * Existence goes through `/topics/{id}`. The messages endpoint answers 200 with
 * an empty list for a topic that was never created, so it cannot answer this.
 */
export async function topicExists(
  topicId: string,
  options: MirrorReadOptions = {},
): Promise<"yes" | "no" | "unknown"> {
  const result = await readMirrorNode(`topics/${encodeURIComponent(topicId)}`, options);
  if (result.ok) return "yes";
  if (result.status === 404) return "no";
  return "unknown";
}

export interface TopicMessageWaitResult<T = unknown> extends MirrorWaitResult<T> {
  /** `no-topic` distinguishes a wrong topic id from a message still in flight. */
  reason?: "no-topic";
}

/**
 * Wait for one message by sequence number. Checks the topic first so a wrong
 * id fails in one read instead of looking like 30 seconds of mirror lag.
 *
 * Uses the query form, which answers `{"messages": [...]}`; the path form
 * `/messages/{n}` answers with the message object at the top level, and the
 * two are not interchangeable.
 */
export async function waitForTopicMessage<T = unknown>(
  topicId: string,
  sequenceNumber: number | string,
  options: MirrorWaitOptions = {},
): Promise<TopicMessageWaitResult<T>> {
  const startedAt = Date.now();
  const exists = await topicExists(topicId, options);
  if (exists === "no") {
    return {
      status: 404,
      ok: false,
      url: `${mirrorNodeBaseUrl(options)}/topics/${topicId}`,
      found: false,
      attempts: 1,
      elapsedMs: Date.now() - startedAt,
      reason: "no-topic",
    };
  }

  const query = `topics/${encodeURIComponent(topicId)}/messages?sequencenumber=eq:${encodeURIComponent(String(sequenceNumber))}`;
  const result = await waitForMirrorNode<{ messages?: T[] }>(query, {
    ...options,
    accept: body => Array.isArray((body as { messages?: unknown[] })?.messages)
      && ((body as { messages: unknown[] }).messages.length > 0),
  });

  const messages = result.body?.messages;
  return {
    ...result,
    body: messages?.[0],
    elapsedMs: Date.now() - startedAt,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
