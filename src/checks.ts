/**
 * Claims read out of the spec, before the app exists.
 *
 * Checks are data, never code. A test file could be edited by the generator on
 * the next attempt, could pass trivially, and would mean the harness running
 * the agent's own program to grade the agent — three ways of losing the thing
 * that makes this worth doing.
 */

/**
 * No deltas. "The balance rose by 2.5" needs a value from before the action,
 * and the harness no longer reads one — the judge reads its own before and
 * after, so a relative claim is something it verifies, cites, and stands
 * behind, not something it states for a machine to confirm.
 */
export type Expectation =
  | { equals: string | number }
  | { matches: string }
  | { contains: string }
  | { atLeast: number };

export interface Check {
  /** `chain:accounts/0.0.2:balance.balance` — the same shape failure identity hashes. */
  id: string;
  kind: "chain" | "http" | "dom";
  /** Mirror node path below `/api/v1/`, e.g. `accounts/0.0.2`. */
  path: string;
  /** Dotted path into the response, e.g. `balance.balance`. Values are in the units the mirror node reports. */
  field: string;
  expect: Expectation;
  because?: string | undefined;
}

/**
 * What a check is, in one line, uniquely.
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

/**
 * A check as an instruction in the judge's brief: the id it must name back,
 * what to read, and what the reading should say. The spec's own words go with
 * it — the judge that disagrees with the item needs them to say how it
 * misread.
 */
export function worded(check: Check): string {
  const reading =
    check.kind === "chain"
      ? `read ${check.path} from the mirror node — ${check.field} should ${claim(check.expect)}`
      : check.kind === "http"
        ? `fetch ${check.path} from the app — its ${check.field} should ${claim(check.expect)}`
        : `open ${check.path} and read what ${check.field} shows — it should ${claim(check.expect)}`;
  const origin = check.because === undefined ? "" : ` (the spec: "${check.because}")`;
  return `${check.id}\n    ${reading}${origin}`;
}

function claim(expect: Expectation): string {
  if ("equals" in expect) return `equal ${JSON.stringify(expect.equals)}`;
  if ("matches" in expect) return `match /${expect.matches}/ — a JavaScript pattern`;
  if ("contains" in expect) return `contain ${JSON.stringify(expect.contains)}`;
  return `be at least ${expect.atLeast}`;
}
