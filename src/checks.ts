/**
 * Claims read out of the spec, before the app exists.
 *
 * The harness does not check them — the judge does. What the harness owns is
 * that they exist before the app does, so nothing about the app can shape
 * them, and that the verdict accounts for every one: what the judge read
 * before it acted, what it read after, whether the claim held, and where a
 * reader can see the reading. The checking is the judge's work; the accounting
 * is mechanical.
 *
 * Checks are data, never code. A test file could be edited by the generator on
 * the next attempt, could pass trivially, and would mean the harness running
 * the agent's own program to grade the agent — three ways of losing the thing
 * that makes this worth doing.
 */

/**
 * Deliberately small: enough to express a claim, too little to express a
 * program. No conditionals, and no check may refer to another — the moment one
 * expectation depends on another's result this is a language, and the reason a
 * person can read it in a second is gone.
 *
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
  /**
   * The words this came from. A check that misreads prose fails a correct app,
   * so a reader — and the judge — has to be able to see the reading.
   */
  because?: string | undefined;
}

/**
 * What a check is, in one line, uniquely.
 *
 * The expectation is part of it. Two claims about one field are two claims —
 * "the body contains the network name" and "the body contains the block
 * number" read the same route and the same field, and collapsing them to one
 * locator would give them one identity, so the judge's accounting could not
 * tell them apart.
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
