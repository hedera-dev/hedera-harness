import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { importHieroSdk } from "../optionalDeps.js";
import type {
  ChainSigner,
  ValidationFinding,
  X402GateResult,
  X402RouteResult,
} from "../types.js";
import type { DevServerSession } from "./devServer.js";

/**
 * x402 gate — deterministic proof that a route is really paywalled.
 *
 * Coding agents that are asked for "an x402-gated endpoint" routinely ship a
 * route that answers 200 to everyone, or a 402 whose PAYMENT-REQUIRED header
 * no client can act on (wrong network, HBAR priced in decimals, no feePayer).
 * The Playwright gate cannot see any of that: a JSON route that returns 200 is
 * a passing route. This gate speaks the protocol instead:
 *
 *   1. request the route with no payment      → must be 402 + PAYMENT-REQUIRED
 *   2. decode the header                       → x402 v2 `PaymentRequired`
 *   3. check every accepted requirement        → Hedera `exact` scheme rules
 *   4. replay with a forged PAYMENT-SIGNATURE  → must still be rejected
 *   5. (opt-in) ask the facilitator            → it settles this network/scheme
 *   6. (opt-in) pay with the CHAIN signer      → 200 + PAYMENT-RESPONSE, then
 *      the transfer is visible on the mirror node
 *
 * Steps 1–4 need nothing but the dev server. Step 6 is the paid request the
 * Hedera x402 story is about, executed by the harness rather than trusted from
 * an agent transcript.
 *
 * Protocol references (x402-foundation/x402):
 *   - specs/transports-v2/http.md (headers)
 *   - specs/schemes/exact/scheme_exact_hedera.md (requirement fields, MUSTs)
 */

export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

export const HBAR_ASSET_ID = "0.0.0";
export const HEDERA_ENTITY_ID_PATTERN = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CAIP2_HEDERA_PATTERN = /^hedera:(mainnet|testnet|previewnet|local)$/;

const DEFAULT_NETWORK = "hedera:testnet";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLEMENT_TIMEOUT_MS = 45_000;
const SETTLEMENT_POLL_MS = 2_000;

const MIRROR_NODE_URLS: Record<string, string> = {
  "hedera:mainnet": "https://mainnet-public.mirrornode.hedera.com",
  "hedera:testnet": "https://testnet.mirrornode.hedera.com",
  "hedera:previewnet": "https://previewnet.mirrornode.hedera.com",
};

export interface X402GateRouteConfig {
  name: string;
  path: string;
  /** HTTP method, default GET. */
  method: string;
  headers?: Record<string, string>;
  /** Request body. Objects are sent as JSON. */
  body?: unknown;
  /** Upper bound the route may ask for, in smallest units (tinybars for HBAR). */
  maxAmount?: string;
  /** Expected receiving account (`0.0.x` or EVM alias). */
  payTo?: string;
  /** Expected asset (`0.0.0` for HBAR, otherwise an HTS token id). */
  asset?: string;
}

export interface X402GateConfig {
  /** CAIP-2 network every accepted requirement must name. */
  network: string;
  /** When set, `GET {facilitatorUrl}/supported` must list `exact` on `network`. */
  facilitatorUrl?: string;
  /** Perform one real payment per route with the CHAIN signer. */
  pay: boolean;
  /** Per-request timeout. */
  timeoutMs: number;
  /** How long to wait for the settlement to appear on the mirror node. */
  settlementTimeoutMs: number;
  mirrorNodeUrl?: string;
  routes: X402GateRouteConfig[];
}

/** One entry of `PaymentRequired.accepts` after shape checks passed. */
export interface AcceptedRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PaymentRequiredEvaluation {
  findings: ValidationFinding[];
  x402Version?: number;
  acceptsCount: number;
  /** First requirement that satisfies the route's constraints, when any does. */
  matched?: AcceptedRequirement;
  resource?: Record<string, unknown>;
}

export interface X402GateOptions {
  /** Default CAIP-2 network when the config omits `network` (from CHAIN). */
  defaultNetwork?: string;
  chainSigner?: ChainSigner;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to real time. */
  sleepImpl?: (ms: number) => Promise<void>;
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function loadX402GateConfig(
  configPath: string,
  defaults: { network?: string } = {},
): Promise<X402GateConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`x402 gate config ${configPath} must be a YAML mapping.`);
  }
  return normalizeX402GateConfig(parsed, configPath, defaults);
}

/** Exported so doctor can validate the recipe without a dev server. */
export function normalizeX402GateConfig(
  parsed: Record<string, unknown>,
  configPath: string,
  defaults: { network?: string } = {},
): X402GateConfig {
  const network = readOptionalString(parsed, "network") ?? defaults.network ?? DEFAULT_NETWORK;
  if (!CAIP2_HEDERA_PATTERN.test(network)) {
    throw new Error(
      `x402 gate config ${configPath}: network must be a Hedera CAIP-2 id such as "hedera:testnet" (got ${JSON.stringify(network)}).`,
    );
  }

  const pay = parsed.pay === true;
  if (pay && network === "hedera:mainnet") {
    throw new Error(
      `x402 gate config ${configPath}: pay: true is not allowed on hedera:mainnet. The harness only spends testnet HBAR.`,
    );
  }

  const routesRaw = parsed.routes;
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    throw new Error(`x402 gate config ${configPath} requires at least one route.`);
  }

  const routes = routesRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`x402 gate config ${configPath}: routes[${index}] must be a mapping.`);
    }
    const record = item as Record<string, unknown>;
    const name = readOptionalString(record, "name");
    const routePath = readOptionalString(record, "path");
    if (!name || !routePath) {
      throw new Error(`x402 gate config ${configPath}: routes[${index}] needs name and path.`);
    }
    const method = (readOptionalString(record, "method") ?? "GET").toUpperCase();
    const maxAmount = readOptionalAmount(record, "maxAmount", `${configPath} routes[${index}]`);
    const payTo = readOptionalString(record, "payTo");
    if (payTo && !isAccountLike(payTo)) {
      throw new Error(
        `x402 gate config ${configPath}: routes[${index}].payTo must be a Hedera account id or EVM address.`,
      );
    }
    const asset = readOptionalString(record, "asset");
    if (asset && !HEDERA_ENTITY_ID_PATTERN.test(asset)) {
      throw new Error(
        `x402 gate config ${configPath}: routes[${index}].asset must be "0.0.0" or an HTS token id.`,
      );
    }
    const headers =
      record.headers && typeof record.headers === "object" && !Array.isArray(record.headers)
        ? Object.fromEntries(
            Object.entries(record.headers as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value),
            ]),
          )
        : undefined;

    return {
      name,
      path: routePath,
      method,
      headers,
      body: record.body,
      maxAmount,
      payTo,
      asset,
    } satisfies X402GateRouteConfig;
  });

  return {
    network,
    facilitatorUrl: readOptionalString(parsed, "facilitatorUrl")?.replace(/\/+$/, ""),
    pay,
    timeoutMs: readOptionalNumber(parsed, "timeoutMs") ?? DEFAULT_TIMEOUT_MS,
    settlementTimeoutMs:
      readOptionalNumber(parsed, "settlementTimeoutMs") ?? DEFAULT_SETTLEMENT_TIMEOUT_MS,
    mirrorNodeUrl: readOptionalString(parsed, "mirrorNodeUrl")?.replace(/\/+$/, ""),
    routes,
  };
}

// ── Gate ──────────────────────────────────────────────────────────────────────

export async function runX402Gate(
  configPath: string,
  devServer: Pick<DevServerSession, "url">,
  options: X402GateOptions = {},
): Promise<{ result: X402GateResult; findings: ValidationFinding[] }> {
  const startedAt = Date.now();
  const config = await loadX402GateConfig(configPath, { network: options.defaultNetwork });
  const fetchImpl = options.fetchImpl ?? fetch;
  const findings: ValidationFinding[] = [];
  const routes: X402RouteResult[] = [];

  if (config.pay && !options.chainSigner) {
    findings.push({
      id: "x402:gate:signer",
      category: "x402",
      message: "x402 gate has pay: true but no CHAIN signer is available",
      details:
        "Enable chainValidation in the recipe so the harness provisions a funded testnet signer, or set pay: false.",
    });
  }

  let facilitatorSupports: boolean | undefined;
  if (config.facilitatorUrl) {
    const supported = await checkFacilitatorSupports(
      config.facilitatorUrl,
      config.network,
      fetchImpl,
      config.timeoutMs,
    );
    facilitatorSupports = supported.ok;
    if (!supported.ok) {
      findings.push({
        id: "x402:facilitator:supported",
        category: "x402",
        message: `Facilitator ${config.facilitatorUrl} does not advertise scheme "exact" on ${config.network}`,
        details: supported.detail,
      });
    }
  }

  for (const route of config.routes) {
    const routeStartedAt = Date.now();
    const routeUrl = joinUrl(devServer.url, route.path);
    const routeResult: X402RouteResult = {
      name: route.name,
      path: route.path,
      method: route.method,
      statusCode: null,
      acceptsCount: 0,
      tamperStatusCode: null,
      durationMs: 0,
    };

    let unpaid: Response;
    try {
      unpaid = await fetchImpl(routeUrl, buildRequestInit(route, config.timeoutMs));
    } catch (error) {
      findings.push(
        routeFinding(route, "request", `x402 route ${route.path} could not be requested`, errorMessage(error)),
      );
      routeResult.durationMs = Date.now() - routeStartedAt;
      routes.push(routeResult);
      continue;
    }
    routeResult.statusCode = unpaid.status;

    if (unpaid.status !== 402) {
      findings.push(
        routeFinding(
          route,
          "status",
          unpaid.status >= 200 && unpaid.status < 300
            ? `x402 route ${route.path} served the resource without payment (HTTP ${unpaid.status}) — the paywall is not enforced`
            : `x402 route ${route.path} answered HTTP ${unpaid.status} to an unpaid request; expected 402 Payment Required`,
          await responseSnippet(unpaid),
        ),
      );
      routeResult.durationMs = Date.now() - routeStartedAt;
      routes.push(routeResult);
      continue;
    }

    const header = unpaid.headers.get(PAYMENT_REQUIRED_HEADER);
    let decoded: unknown;
    if (!header) {
      const bodyText = await unpaid.text().catch(() => "");
      const legacy = tryParseJson(bodyText);
      const looksLikeV1 =
        legacy && typeof legacy === "object" && Array.isArray((legacy as { accepts?: unknown }).accepts);
      findings.push(
        routeFinding(
          route,
          "header",
          looksLikeV1
            ? `x402 route ${route.path} answers 402 with an x402 v1 JSON body but no PAYMENT-REQUIRED header; Hedera exact-scheme clients and facilitators speak x402 v2`
            : `x402 route ${route.path} answers 402 without a PAYMENT-REQUIRED header, so no x402 client can pay for it`,
          truncate(bodyText, 300) || undefined,
        ),
      );
      routeResult.durationMs = Date.now() - routeStartedAt;
      routes.push(routeResult);
      continue;
    }

    try {
      decoded = decodePaymentRequiredHeader(header);
    } catch (error) {
      findings.push(
        routeFinding(
          route,
          "decode",
          `x402 route ${route.path} sent a PAYMENT-REQUIRED header that is not base64-encoded JSON`,
          errorMessage(error),
        ),
      );
      routeResult.durationMs = Date.now() - routeStartedAt;
      routes.push(routeResult);
      continue;
    }

    const evaluation = evaluatePaymentRequired(decoded, route, config.network);
    routeResult.x402Version = evaluation.x402Version;
    routeResult.acceptsCount = evaluation.acceptsCount;
    findings.push(...evaluation.findings);

    if (!evaluation.matched) {
      routeResult.durationMs = Date.now() - routeStartedAt;
      routes.push(routeResult);
      continue;
    }
    routeResult.requirement = summarizeRequirement(evaluation.matched);

    // A forged payment must be rejected. Servers that only check that the header
    // exists — or that crash while decoding it — fail here.
    try {
      const forged = await fetchImpl(
        routeUrl,
        buildRequestInit(route, config.timeoutMs, {
          [PAYMENT_SIGNATURE_HEADER]: encodeBase64Json({
            x402Version: 2,
            resource: evaluation.resource,
            accepted: evaluation.matched,
            payload: { transaction: Buffer.from("not-a-hedera-transaction").toString("base64") },
          }),
        }),
      );
      routeResult.tamperStatusCode = forged.status;
      if (forged.status >= 200 && forged.status < 300) {
        findings.push(
          routeFinding(
            route,
            "tamper",
            `x402 route ${route.path} served the resource for a forged PAYMENT-SIGNATURE (HTTP ${forged.status}) — payments are not verified`,
            await responseSnippet(forged),
          ),
        );
      } else if (forged.status >= 500) {
        findings.push(
          routeFinding(
            route,
            "tamper",
            `x402 route ${route.path} crashed on a malformed PAYMENT-SIGNATURE (HTTP ${forged.status}); it should answer 402 again`,
            await responseSnippet(forged),
          ),
        );
      }
    } catch (error) {
      findings.push(
        routeFinding(
          route,
          "tamper",
          `x402 route ${route.path} could not be re-requested with a forged payment`,
          errorMessage(error),
        ),
      );
    }

    if (config.pay && options.chainSigner && facilitatorSupports !== false) {
      const paid = await payRoute({
        route,
        routeUrl,
        config,
        requirement: evaluation.matched,
        resource: evaluation.resource,
        signer: options.chainSigner,
        fetchImpl,
        sleepImpl: options.sleepImpl ?? sleep,
      });
      routeResult.paid = paid.result;
      findings.push(...paid.findings);
    }

    routeResult.durationMs = Date.now() - routeStartedAt;
    routes.push(routeResult);
  }

  return {
    result: {
      passed: findings.length === 0,
      configPath,
      serverUrl: devServer.url,
      network: config.network,
      facilitatorUrl: config.facilitatorUrl,
      paid: config.pay,
      routes,
      durationMs: Date.now() - startedAt,
    },
    findings,
  };
}

// ── PaymentRequired checks (pure) ─────────────────────────────────────────────

export function decodePaymentRequiredHeader(header: string): unknown {
  const text = Buffer.from(header.trim(), "base64").toString("utf8");
  if (!text.trim()) {
    throw new Error("header decoded to an empty string");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`decoded header is not JSON: ${errorMessage(error)}`);
  }
}

/**
 * Grade a decoded `PaymentRequired` object against the Hedera `exact` scheme
 * and the route's constraints. Pure; exported for unit tests.
 */
export function evaluatePaymentRequired(
  decoded: unknown,
  route: X402GateRouteConfig,
  network: string,
): PaymentRequiredEvaluation {
  const findings: ValidationFinding[] = [];

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    findings.push(
      routeFinding(route, "shape", `x402 route ${route.path}: PAYMENT-REQUIRED must decode to a JSON object`),
    );
    return { findings, acceptsCount: 0 };
  }
  const record = decoded as Record<string, unknown>;
  const x402Version = typeof record.x402Version === "number" ? record.x402Version : undefined;

  if (x402Version !== 2) {
    findings.push(
      routeFinding(
        route,
        "version",
        `x402 route ${route.path} advertises x402Version ${JSON.stringify(record.x402Version)}; the Hedera exact scheme requires 2`,
      ),
    );
  }

  const resource =
    record.resource && typeof record.resource === "object" && !Array.isArray(record.resource)
      ? (record.resource as Record<string, unknown>)
      : undefined;
  if (!resource || typeof resource.url !== "string" || !resource.url.trim()) {
    findings.push(
      routeFinding(
        route,
        "resource",
        `x402 route ${route.path}: PAYMENT-REQUIRED.resource.url is missing; clients echo it back in the payment payload`,
      ),
    );
  }

  const accepts = Array.isArray(record.accepts) ? record.accepts : [];
  if (accepts.length === 0) {
    findings.push(
      routeFinding(
        route,
        "accepts",
        `x402 route ${route.path}: PAYMENT-REQUIRED.accepts is empty — nothing tells a client how to pay`,
      ),
    );
    return { findings, x402Version, acceptsCount: 0, resource };
  }

  const problems: string[] = [];
  let malformed = 0;
  let matched: AcceptedRequirement | undefined;
  accepts.forEach((entry, index) => {
    const result = checkRequirement(entry, index, route, network);
    if (result.ok) {
      matched ??= result.requirement;
    } else {
      malformed += 1;
      problems.push(...result.problems);
    }
  });

  if (!matched) {
    findings.push(
      routeFinding(
        route,
        "requirement",
        `x402 route ${route.path}: none of the ${accepts.length} accepted payment option(s) is a valid Hedera exact requirement on ${network}`,
        problems.join("\n"),
      ),
    );
  } else if (problems.length > 0) {
    // A usable option exists; the others are still wrong and will confuse
    // clients that pick the first entry.
    findings.push(
      routeFinding(
        route,
        "requirement",
        `x402 route ${route.path}: ${malformed} accepted payment option(s) are malformed alongside a valid one`,
        problems.join("\n"),
      ),
    );
  }

  return { findings, x402Version, acceptsCount: accepts.length, matched, resource };
}

function checkRequirement(
  entry: unknown,
  index: number,
  route: X402GateRouteConfig,
  network: string,
): { ok: true; requirement: AcceptedRequirement } | { ok: false; problems: string[] } {
  const prefix = `accepts[${index}]`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, problems: [`${prefix}: not an object`] };
  }
  const record = entry as Record<string, unknown>;
  const problems: string[] = [];

  if (record.scheme !== "exact") {
    problems.push(`${prefix}.scheme is ${JSON.stringify(record.scheme)}; Hedera x402 uses "exact"`);
  }
  if (record.network !== network) {
    problems.push(
      `${prefix}.network is ${JSON.stringify(record.network)}; the recipe expects ${network}`,
    );
  }

  const amount = record.amount ?? record.maxAmountRequired;
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    problems.push(
      `${prefix}.amount must be a string of whole smallest units (tinybars for HBAR), got ${JSON.stringify(amount)}`,
    );
  } else if (BigInt(amount) <= 0n) {
    problems.push(`${prefix}.amount must be greater than zero`);
  } else if (route.maxAmount !== undefined && BigInt(amount) > BigInt(route.maxAmount)) {
    problems.push(
      `${prefix}.amount ${amount} exceeds the recipe ceiling of ${route.maxAmount} smallest units`,
    );
  }

  const asset = record.asset;
  if (typeof asset !== "string" || !HEDERA_ENTITY_ID_PATTERN.test(asset)) {
    problems.push(
      `${prefix}.asset must be "0.0.0" (HBAR) or an HTS token id, got ${JSON.stringify(asset)}`,
    );
  } else if (route.asset !== undefined && asset !== route.asset) {
    problems.push(`${prefix}.asset is ${asset}; the recipe expects ${route.asset}`);
  }

  const payTo = record.payTo;
  if (typeof payTo !== "string" || !isAccountLike(payTo)) {
    problems.push(
      `${prefix}.payTo must be a Hedera account id or EVM address, got ${JSON.stringify(payTo)}`,
    );
  } else if (route.payTo !== undefined && payTo.toLowerCase() !== route.payTo.toLowerCase()) {
    problems.push(`${prefix}.payTo is ${payTo}; the recipe expects ${route.payTo}`);
  }

  if (
    record.maxTimeoutSeconds !== undefined &&
    (typeof record.maxTimeoutSeconds !== "number" ||
      !Number.isInteger(record.maxTimeoutSeconds) ||
      record.maxTimeoutSeconds <= 0)
  ) {
    problems.push(`${prefix}.maxTimeoutSeconds must be a positive integer`);
  }

  const extra =
    record.extra && typeof record.extra === "object" && !Array.isArray(record.extra)
      ? (record.extra as Record<string, unknown>)
      : undefined;
  const feePayer = extra?.feePayer;
  if (typeof feePayer !== "string" || !HEDERA_ENTITY_ID_PATTERN.test(feePayer)) {
    problems.push(
      `${prefix}.extra.feePayer must be the facilitator account id that sponsors fees (Hedera exact scheme MUST), got ${JSON.stringify(feePayer)}`,
    );
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    requirement: {
      ...record,
      scheme: "exact",
      network,
      amount: amount as string,
      asset: asset as string,
      payTo: payTo as string,
      maxTimeoutSeconds:
        typeof record.maxTimeoutSeconds === "number" ? record.maxTimeoutSeconds : undefined,
      extra,
    },
  };
}

// ── Facilitator ───────────────────────────────────────────────────────────────

export async function checkFacilitatorSupports(
  facilitatorUrl: string,
  network: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; detail?: string }> {
  const url = `${facilitatorUrl}/supported`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, detail: `GET ${url} failed: ${errorMessage(error)}` };
  }
  if (!response.ok) {
    return { ok: false, detail: `GET ${url} answered HTTP ${response.status}` };
  }
  const body = tryParseJson(await response.text().catch(() => ""));
  const kinds =
    body && typeof body === "object" && Array.isArray((body as { kinds?: unknown }).kinds)
      ? ((body as { kinds: unknown[] }).kinds as Array<Record<string, unknown>>)
      : [];
  const match = kinds.some(
    kind =>
      kind &&
      typeof kind === "object" &&
      kind.scheme === "exact" &&
      kind.network === network &&
      (kind.x402Version === undefined || kind.x402Version === 2),
  );
  if (match) return { ok: true };
  const advertised = kinds
    .map(kind => `${String(kind?.scheme)}@${String(kind?.network)}`)
    .filter((value, index, all) => all.indexOf(value) === index);
  return {
    ok: false,
    detail: `GET ${url} lists: ${advertised.length > 0 ? advertised.join(", ") : "(no kinds)"}`,
  };
}

// ── Paid probe ────────────────────────────────────────────────────────────────

interface PayRouteInput {
  route: X402GateRouteConfig;
  routeUrl: string;
  config: X402GateConfig;
  requirement: AcceptedRequirement;
  resource?: Record<string, unknown>;
  signer: ChainSigner;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
}

async function payRoute(
  input: PayRouteInput,
): Promise<{ result: NonNullable<X402RouteResult["paid"]>; findings: ValidationFinding[] }> {
  const { route, routeUrl, config, requirement, signer, fetchImpl } = input;
  const findings: ValidationFinding[] = [];
  const result: NonNullable<X402RouteResult["paid"]> = {
    statusCode: null,
    settled: false,
  };

  let transaction: string;
  try {
    transaction = await buildExactHederaPayment(signer, requirement, config.network);
  } catch (error) {
    findings.push(
      routeFinding(
        route,
        "pay",
        `x402 route ${route.path}: the harness could not build a payment for the advertised requirement`,
        errorMessage(error),
      ),
    );
    return { result, findings };
  }

  const paymentHeader = encodeBase64Json({
    x402Version: 2,
    resource: input.resource,
    accepted: requirement,
    payload: { transaction },
  });

  let response: Response;
  try {
    response = await fetchImpl(
      routeUrl,
      buildRequestInit(route, Math.max(config.timeoutMs, 30_000), {
        [PAYMENT_SIGNATURE_HEADER]: paymentHeader,
      }),
    );
  } catch (error) {
    findings.push(
      routeFinding(route, "pay", `x402 route ${route.path}: the paid request failed`, errorMessage(error)),
    );
    return { result, findings };
  }
  result.statusCode = response.status;

  if (response.status < 200 || response.status >= 300) {
    findings.push(
      routeFinding(
        route,
        "pay",
        `x402 route ${route.path} rejected a valid payment of ${requirement.amount} (${describeAsset(requirement.asset)}) from ${signer.accountId} with HTTP ${response.status}`,
        [
          await responseSnippet(response),
          decodeHeaderSnippet(response.headers.get(PAYMENT_REQUIRED_HEADER)),
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
    return { result, findings };
  }

  const settlementHeader = response.headers.get(PAYMENT_RESPONSE_HEADER);
  if (!settlementHeader) {
    findings.push(
      routeFinding(
        route,
        "settlement",
        `x402 route ${route.path} accepted the payment but sent no PAYMENT-RESPONSE header; clients cannot learn the settlement transaction`,
      ),
    );
    return { result, findings };
  }

  let settlement: Record<string, unknown>;
  try {
    const decoded = decodePaymentRequiredHeader(settlementHeader);
    if (!decoded || typeof decoded !== "object") throw new Error("not an object");
    settlement = decoded as Record<string, unknown>;
  } catch (error) {
    findings.push(
      routeFinding(
        route,
        "settlement",
        `x402 route ${route.path}: PAYMENT-RESPONSE is not base64-encoded JSON`,
        errorMessage(error),
      ),
    );
    return { result, findings };
  }

  const transactionId =
    typeof settlement.transaction === "string" && settlement.transaction
      ? settlement.transaction
      : typeof settlement.transactionId === "string"
        ? settlement.transactionId
        : undefined;
  result.transactionId = transactionId;

  if (settlement.success !== true || !transactionId) {
    findings.push(
      routeFinding(
        route,
        "settlement",
        `x402 route ${route.path} served the resource but PAYMENT-RESPONSE reports no successful settlement`,
        JSON.stringify(settlement).slice(0, 400),
      ),
    );
    return { result, findings };
  }

  const mirrorUrl = config.mirrorNodeUrl ?? MIRROR_NODE_URLS[config.network];
  if (!mirrorUrl) {
    result.settled = true;
    return { result, findings };
  }

  const verified = await verifySettlementOnMirror({
    mirrorUrl,
    transactionId,
    requirement,
    fetchImpl,
    sleepImpl: input.sleepImpl,
    timeoutMs: config.settlementTimeoutMs,
    requestTimeoutMs: config.timeoutMs,
  });
  result.settled = verified.ok;
  result.mirrorUrl = verified.url;
  if (!verified.ok) {
    findings.push(
      routeFinding(
        route,
        "settlement",
        `x402 route ${route.path}: settlement ${transactionId} is not visible as a successful transfer of ${requirement.amount} (${describeAsset(requirement.asset)}) to ${requirement.payTo} on the mirror node`,
        verified.detail,
      ),
    );
  }
  return { result, findings };
}

/**
 * Build the partially signed `TransferTransaction` the Hedera exact scheme
 * expects: payer → payTo for `amount`, fee payer = `extra.feePayer`, signed by
 * the payer only. Returned base64, ready for `payload.transaction`.
 */
export async function buildExactHederaPayment(
  signer: ChainSigner,
  requirement: AcceptedRequirement,
  network: string,
): Promise<string> {
  const sdk = await importHieroSdk();
  const feePayer = requirement.extra?.feePayer;
  if (typeof feePayer !== "string") {
    throw new Error("requirement.extra.feePayer is required");
  }
  const amount = BigInt(requirement.amount);
  if (amount <= 0n) {
    throw new Error("requirement.amount must be greater than zero");
  }

  const payer = sdk.AccountId.fromString(signer.accountId);
  const payTo = EVM_ADDRESS_PATTERN.test(requirement.payTo)
    ? sdk.AccountId.fromEvmAddress(0, 0, requirement.payTo)
    : sdk.AccountId.fromString(requirement.payTo);

  const transaction = new sdk.TransferTransaction();
  if (requirement.asset === HBAR_ASSET_ID) {
    transaction.addHbarTransfer(payer, sdk.Hbar.fromTinybars((-amount).toString()));
    transaction.addHbarTransfer(payTo, sdk.Hbar.fromTinybars(amount.toString()));
  } else {
    const tokenId = sdk.TokenId.fromString(requirement.asset);
    transaction.addTokenTransfer(tokenId, payer, sdk.Long.fromString((-amount).toString()));
    transaction.addTokenTransfer(tokenId, payTo, sdk.Long.fromString(amount.toString()));
  }
  transaction.setTransactionId(sdk.TransactionId.generate(sdk.AccountId.fromString(feePayer)));
  if (requirement.maxTimeoutSeconds) {
    transaction.setTransactionValidDuration(Math.min(180, requirement.maxTimeoutSeconds));
  }

  const client =
    network === "hedera:mainnet"
      ? sdk.Client.forMainnet()
      : network === "hedera:previewnet"
        ? sdk.Client.forPreviewnet()
        : sdk.Client.forTestnet();
  try {
    transaction.freezeWith(client);
    const key = sdk.PrivateKey.fromStringECDSA(signer.privateKeyHex.replace(/^0x/, ""));
    const signed = await transaction.sign(key);
    return Buffer.from(signed.toBytes()).toString("base64");
  } finally {
    client.close();
  }
}

/**
 * Poll the mirror node until the settlement transaction is SUCCESS and credits
 * `payTo` with exactly `amount` of `asset`.
 */
export async function verifySettlementOnMirror(input: {
  mirrorUrl: string;
  transactionId: string;
  requirement: AcceptedRequirement;
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  timeoutMs: number;
  requestTimeoutMs: number;
}): Promise<{ ok: boolean; url: string; detail?: string }> {
  const formatted = formatMirrorTransactionId(input.transactionId);
  const url = `${input.mirrorUrl}/api/v1/transactions/${encodeURIComponent(formatted)}`;
  const deadline = Date.now() + input.timeoutMs;
  let lastDetail = "no response yet";

  while (true) {
    try {
      const response = await input.fetchImpl(url, {
        signal: AbortSignal.timeout(input.requestTimeoutMs),
      });
      if (response.status === 404) {
        lastDetail = `mirror node has not indexed ${formatted} yet`;
      } else if (!response.ok) {
        lastDetail = `GET ${url} answered HTTP ${response.status}`;
      } else {
        const body = tryParseJson(await response.text()) as
          | { transactions?: Array<Record<string, unknown>> }
          | null;
        const transactions = Array.isArray(body?.transactions) ? body!.transactions : [];
        const verdict = gradeMirrorTransactions(transactions, input.requirement);
        if (verdict.ok) return { ok: true, url };
        lastDetail = verdict.detail;
        if (verdict.terminal) return { ok: false, url, detail: verdict.detail };
      }
    } catch (error) {
      lastDetail = `GET ${url} failed: ${errorMessage(error)}`;
    }

    if (Date.now() >= deadline) {
      return { ok: false, url, detail: lastDetail };
    }
    await input.sleepImpl(SETTLEMENT_POLL_MS);
  }
}

/** Pure grading of a mirror `transactions[]` payload; exported for tests. */
export function gradeMirrorTransactions(
  transactions: Array<Record<string, unknown>>,
  requirement: AcceptedRequirement,
): { ok: boolean; terminal: boolean; detail: string } {
  if (transactions.length === 0) {
    return { ok: false, terminal: false, detail: "mirror node returned no transactions for the id" };
  }
  const expected = BigInt(requirement.amount);
  const payTo = requirement.payTo.toLowerCase();

  for (const transaction of transactions) {
    const result = String(transaction.result ?? "");
    if (result !== "SUCCESS") {
      return {
        ok: false,
        terminal: true,
        detail: `transaction result is ${result || "unknown"}, expected SUCCESS`,
      };
    }
    const credits =
      requirement.asset === HBAR_ASSET_ID
        ? ((Array.isArray(transaction.transfers) ? transaction.transfers : []) as Array<
            Record<string, unknown>
          >)
        : (
            (Array.isArray(transaction.token_transfers) ? transaction.token_transfers : []) as Array<
              Record<string, unknown>
            >
          ).filter(entry => String(entry.token_id) === requirement.asset);

    const credited = credits
      .filter(
        entry =>
          typeof entry.account === "string" &&
          entry.account.toLowerCase() === payTo &&
          Number(entry.amount) > 0,
      )
      .reduce((sum, entry) => sum + BigInt(Math.trunc(Number(entry.amount))), 0n);

    if (credited === expected) {
      return { ok: true, terminal: true, detail: "" };
    }
    return {
      ok: false,
      terminal: true,
      detail: `payTo ${requirement.payTo} was credited ${credited} of ${describeAsset(requirement.asset)}, expected exactly ${expected}`,
    };
  }
  return { ok: false, terminal: false, detail: "no gradable transaction" };
}

/** `0.0.1235@1700000000.000000000` → `0.0.1235-1700000000-000000000` (mirror REST form). */
export function formatMirrorTransactionId(transactionId: string): string {
  const trimmed = transactionId.trim();
  const match = trimmed.match(/^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`;
  }
  return trimmed;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function buildRequestInit(
  route: X402GateRouteConfig,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  const headers: Record<string, string> = {
    accept: "application/json, */*",
    ...(route.headers ?? {}),
    ...extraHeaders,
  };
  let body: string | undefined;
  if (route.body !== undefined && route.method !== "GET" && route.method !== "HEAD") {
    if (typeof route.body === "string") {
      body = route.body;
    } else {
      body = JSON.stringify(route.body);
      headers["content-type"] ??= "application/json";
    }
  }
  return {
    method: route.method,
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function routeFinding(
  route: X402GateRouteConfig,
  check: string,
  message: string,
  details?: string,
): ValidationFinding {
  return {
    id: `x402:route:${route.name}:${check}`,
    category: "x402",
    message,
    details: details || undefined,
  };
}

function summarizeRequirement(requirement: AcceptedRequirement): X402RouteResult["requirement"] {
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    amount: requirement.amount,
    asset: requirement.asset,
    payTo: requirement.payTo,
    feePayer: typeof requirement.extra?.feePayer === "string" ? requirement.extra.feePayer : undefined,
  };
}

function isAccountLike(value: string): boolean {
  return HEDERA_ENTITY_ID_PATTERN.test(value) || EVM_ADDRESS_PATTERN.test(value);
}

function describeAsset(asset: string): string {
  return asset === HBAR_ASSET_ID ? "tinybars of HBAR" : `smallest units of HTS token ${asset}`;
}

function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeHeaderSnippet(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    return `PAYMENT-REQUIRED: ${truncate(JSON.stringify(decodePaymentRequiredHeader(header)), 400)}`;
  } catch {
    return undefined;
  }
}

async function responseSnippet(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  return truncate(text, 300) || undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function joinUrl(baseUrl: string, routePath: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL(routePath.replace(/^\//, ""), base).toString();
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected non-empty string "${key}".`);
  }
  return value.trim();
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Expected positive number "${key}".`);
  }
  return value;
}

function readOptionalAmount(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) {
    throw new Error(
      `x402 gate config ${where}.${key} must be a whole number of smallest units (tinybars for HBAR), got ${JSON.stringify(value)}.`,
    );
  }
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
