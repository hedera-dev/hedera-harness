/**
 * Claims the harness can settle without asking anyone.
 *
 * A verdict must show its work. Today that confirms a cited screenshot exists;
 * this confirms the claim is true. The evaluator says what is worth checking —
 * it has used the app and knows what the run created — and the harness reads
 * the mirror node itself and decides. The agent never reports whether its own
 * check held.
 *
 * Chain reads first and alone, because they are the only kind that consults a
 * system the agent cannot influence. Re-reading a page the agent just read,
 * through the same browser, catches an agent misreporting and little else.
 *
 * Checks are data, never code. A test file could be edited by the generator on
 * the next attempt, could pass trivially, and would mean the harness running
 * the agent's own program to grade the agent — three ways of losing the thing
 * that makes this worth doing.
 */
import { emit } from "./events.js";

/** Attempts and spacing for a chain read, since state takes a moment to propagate. */
const ATTEMPTS = 3;
const SPACING_MS = 2_000;

/** A page, and then the thing on it. Client-rendered values arrive after the paint. */
const PAGE_MS = 20_000;
const ELEMENT_MS = 10_000;

/**
 * After the element exists, before it is read.
 *
 * `waitForSelector` returns the moment the element is in the DOM, which for a
 * client-rendered page is while it still shows its placeholder — so reading
 * there gets the em dash rather than the balance. Network idle covers a value
 * fetched on mount; this covers one written by a timer, which is how anything
 * that polls behaves, including specs we have already written.
 */
const SETTLE_MS = 700;

/**
 * Deliberately small: enough to express a claim, too little to express a
 * program. No conditionals, and no check may refer to another — the moment one
 * expectation depends on another's result this is a language, and the reason a
 * person can read it in a second is gone.
 */
export type Expectation =
  | { equals: string | number }
  | { matches: string }
  | { contains: string }
  | { atLeast: number }
  /** Signed delta against the value when the check was declared. */
  | { changedBy: number }
  | { increasedBy: number };

export interface Check {
  /** `chain:accounts/0.0.2:balance.balance` — the same shape failure identity hashes. */
  id: string;
  /**
   * Who made this claim, which decides what it can do. `declared` comes from
   * the evaluator, about something it watched happen: if that fails, the judge
   * has contradicted itself, and nothing is a better reason to reject the run.
   * `derived` is a reading of prose written before the app existed — when it
   * disagrees with the app, either of the two could be wrong and nothing here
   * can say which, so it is reported and never overrides.
   */
  source: "declared" | "derived";
  kind: "chain" | "http" | "dom";
  /** Mirror node path below `/api/v1/`, e.g. `accounts/0.0.2`. */
  path: string;
  /** Dotted path into the response, e.g. `balance.balance`. Values are in the units the mirror node reports. */
  field: string;
  expect: Expectation;
  /** The value when this was declared, for the delta expectations. */
  baseline?: number | undefined;
  /**
   * The words this came from, when it was read out of a spec rather than
   * declared by someone who used the app. A check that misreads prose fails a
   * correct app, so a reader has to be able to see the reading.
   */
  because?: string | undefined;
}

/**
 * A check resolves three ways, not two. `errored` means unexecutable — the
 * path 404s, the field is absent — and it is a warning, never a failure. A
 * mechanical layer that manufactures failures out of its own bugs stops being
 * the thing worth trusting over the judge.
 */
export interface CheckResult {
  check: Check;
  state: "held" | "failed" | "errored";
  /** What was found, or why it could not be read. Shown to a person as-is. */
  detail: string;
}

/**
 * What a check is, in one line, uniquely.
 *
 * The expectation is part of it. Two claims about one field are two claims —
 * "the body contains the network name" and "the body contains the block
 * number" read the same route and the same field, and collapsing them to one
 * locator would give them one identity, so the convergence tally would see a
 * fixed check and a broken one as the same thing.
 */
export function locate(
  kind: "chain" | "http" | "dom",
  path: string,
  field: string,
  expect: Expectation,
): string {
  const [how, what] = Object.entries(expect)[0] ?? ["", ""];
  return `${kind}:${path}:${field}:${how}=${String(what).slice(0, 40)}`;
}

/** Where a check goes looking: the chain for one kind, the running app for the other. */
export interface Where {
  mirrorNode: string;
  appUrl: string;
}

/**
 * Reads what a selector actually shows, in a real browser.
 *
 * The only kind that needs one. `http` sees the served HTML, which for anything
 * rendered on the client is an empty shell — a spec that says `#balance` shows a
 * number is unanswerable from the response body of a Next.js app. That is the
 * whole reason this exists, and the reason it is worth a browser launch.
 *
 * A page that will not load is unreadable and warns. A page that loads without
 * the element has failed the claim: the spec said it would be there.
 */
export type Look = (route: string, selector: string) => Promise<{ value: unknown } | { error: string }>;

/** Reads `field` out of the app's own answer for a route: `status`, or `body`. */
export async function reach(
  appUrl: string,
  route: string,
  field: string,
): Promise<{ value: unknown } | { error: string }> {
  const url = `${appUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
  const response = await fetch(url).catch((error: Error) => error);
  if (response instanceof Error) return { error: `${url} could not be reached: ${response.message}` };
  if (field === "status") return { value: response.status };
  if (field !== "body") return { error: `an http check reads \`status\` or \`body\`, not \`${field}\`` };
  return { value: await response.text().catch(() => "") };
}

/** Reads `field` out of the mirror node's answer for `path`. */
export async function read(
  mirrorNode: string,
  path: string,
  field: string,
): Promise<{ value: unknown } | { error: string }> {
  const url = `${mirrorNode.replace(/\/$/, "")}/api/v1/${path.replace(/^\//, "")}`;
  const response = await fetch(url).catch((error: Error) => error);
  if (response instanceof Error) return { error: `${url} could not be reached: ${response.message}` };
  if (!response.ok) return { error: `${url} answered ${response.status}` };

  const body = (await response.json().catch(() => null)) as unknown;
  if (body === null) return { error: `${url} did not answer with JSON` };

  const value = field.split(".").reduce<unknown>(
    (into, key) => (into !== null && typeof into === "object" ? (into as Record<string, unknown>)[key] : undefined),
    body,
  );
  return value === undefined ? { error: `${url} has no ${field}` } : { value };
}

/**
 * Settles one check, retrying only while it fails. Chain state propagates, so a
 * claim made the instant after a transaction can be true and not yet visible;
 * an unreadable path is not retried, because that is not going to change.
 */
export async function settle(where: Where, check: Check, look?: Look): Promise<CheckResult> {
  let last: CheckResult | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const found =
      check.kind === "dom"
        ? look === undefined
          ? { error: "no browser was open to look with" }
          : await look(check.path, check.field)
        : check.kind === "http"
          ? await reach(where.appUrl, check.path, check.field)
          : await read(where.mirrorNode, check.path, check.field);
    if ("error" in found) return { check, state: "errored", detail: found.error };

    last = compare(check, found.value);
    if (last.state === "held") return last;
    if (attempt < ATTEMPTS) await new Promise((resume) => setTimeout(resume, SPACING_MS));
  }
  return last ?? { check, state: "errored", detail: "no reading was taken" };
}

/** A whole HTML page is the wrong answer to "what was there". */
const SHOWN = 120;

function compare(check: Check, value: unknown): CheckResult {
  const seen = JSON.stringify(value) ?? "";
  const found = `found ${seen.length <= SHOWN ? seen : `${seen.slice(0, SHOWN - 1)}…`}`;
  const held = (state: boolean, expected: string): CheckResult => ({
    check,
    state: state ? "held" : "failed",
    detail: state ? found : `expected ${expected}, ${found}`,
  });
  const expect = check.expect;

  if ("matches" in expect) {
    // A pattern that will not parse is the check being wrong, not the app. The
    // deriver wrote `(?i)not.?found` for a real spec — ordinary in most
    // languages, not a thing in JavaScript — and an uncaught throw here would
    // take the whole run with it.
    let pattern: RegExp;
    try {
      pattern = new RegExp(expect.matches);
    } catch (error) {
      return { check, state: "errored", detail: `unusable pattern: ${(error as Error).message}` };
    }
    return held(pattern.test(String(value)), `to match ${expect.matches}`);
  }
  if ("contains" in expect) {
    return held(String(value).includes(expect.contains), `to contain ${expect.contains}`);
  }
  if ("equals" in expect) {
    return held(String(value) === String(expect.equals), `${expect.equals}`);
  }

  // The numeric half. A field that is not a number is the check's mistake, not
  // the app's, so it errors rather than failing.
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return { check, state: "errored", detail: `${check.field} is not a number (${found})` };
  }
  if ("atLeast" in expect) return held(numeric >= expect.atLeast, `at least ${expect.atLeast}`);

  if (check.baseline === undefined) {
    return { check, state: "errored", detail: "no baseline was captured when this was declared" };
  }
  const moved = numeric - check.baseline;
  if ("increasedBy" in expect) {
    return held(moved === expect.increasedBy, `a rise of ${expect.increasedBy}, found ${moved}`);
  }
  return held(moved === expect.changedBy, `a change of ${expect.changedBy}, found ${moved}`);
}

/**
 * Captures the value a delta will be measured against, at the moment the check
 * is declared. This is why declaration precedes the action rather than the
 * verdict: "the balance rose by 2.5" is unverifiable if nothing was written
 * down beforehand, and by the time a verdict exists the moment has passed.
 */
export async function baseline(mirrorNode: string, check: Check): Promise<Check> {
  if (!("changedBy" in check.expect) && !("increasedBy" in check.expect)) return check;
  if (check.kind !== "chain") return check;
  const found = await read(mirrorNode, check.path, check.field);
  if ("error" in found) return check;
  const numeric = Number(found.value);
  return Number.isNaN(numeric) ? check : { ...check, baseline: numeric };
}

/** Settles every check, reporting each as it lands. */
export async function settleAll(
  where: Where,
  checks: Check[],
  attempt: number,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  // One browser for every selector, opened only if something needs it: a launch
  // costs a second or two, and most runs have nothing to look at.
  const looking = checks.some((check) => check.kind === "dom") ? await opens(where.appUrl) : null;

  try {
    for (const check of checks) {
      const result = await settle(where, check, looking?.look);
    emit({
      type: "check:settled",
      id: result.check.id,
      source: result.check.source,
      state: result.state,
      detail: result.detail,
      because: result.check.because,
      attempt,
    });
      results.push(result);
    }
  } finally {
    await looking?.close();
  }
  return results;
}

/**
 * A browser, and a way to read one element with it. Waits for the selector
 * rather than for the page, because the values a spec cares about arrive after
 * the first paint.
 */
async function opens(appUrl: string): Promise<{ look: Look; close: () => Promise<void> }> {
  // Declared rather than borrowed. It arrives under `@playwright/cli` anyway,
  // so naming it adds no install weight — but importing a transitive dependency
  // means a minor bump in the package above could move it and break this at
  // runtime, on a path that only runs when a spec names an element.
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });

  const look: Look = async (route, selector) => {
    const url = `${appUrl.replace(/\/$/, "")}/${route.replace(/^\//, "")}`;
    const page = await browser.newPage();
    try {
      const response = await page
        .goto(url, { timeout: PAGE_MS, waitUntil: "networkidle" })
        .catch(() => null);
      if (response === null) return { error: `${url} would not load` };

      const element = await page.waitForSelector(selector, { timeout: ELEMENT_MS }).catch(() => null);
      // Not an error: the spec said this would be here, and it is not.
      if (element === null) return { value: null };

      await page.waitForTimeout(SETTLE_MS);
      return { value: (await element.textContent())?.trim() ?? "" };
    } finally {
      await page.close().catch(() => undefined);
    }
  };
  return { look, close: () => browser.close().catch(() => undefined) };
}
