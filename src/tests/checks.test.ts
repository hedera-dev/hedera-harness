import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type Check, locate, worded } from "../checks.js";
import { adjudicate, type Verdict } from "../evaluate.js";

/**
 * The harness no longer reads the chain — the judge does, and the harness keeps
 * the books. So what is tested here is not that values compare correctly but
 * that the accounting is enforced: every item answered for, both readings
 * present for a chain claim, and no pass over a claim the judge itself said
 * did not hold without saying why.
 */
function claim(expect: Check["expect"], over: Partial<Check> = {}): Check {
  return {
    id: locate("chain", "accounts/0.0.2", "balance.balance", expect),
    kind: "chain",
    path: "accounts/0.0.2",
    field: "balance.balance",
    expect,
    ...over,
  };
}

async function workspace(files: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-adjudicate-"));
  await mkdir(join(dir, "evidence"), { recursive: true });
  for (const name of files) await writeFile(join(dir, "evidence", name), "x");
  return dir;
}

function verdict(verified: Verdict["verified"], pass = true): Verdict {
  return { pass, failures: [], verified };
}

const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1/accounts/0.0.2";

test("two claims about one field are two checks", () => {
  const body = (contains: string) => locate("http", "/status", "body", { contains });
  assert.notEqual(
    body("Hedera Testnet"),
    body("40628061"),
    "one route, one field, two claims — collapsing them would give them one identity",
  );
  assert.match(locate("chain", "accounts/0.0.2", "balance.balance", { atLeast: 1 }), /^chain:accounts/);
  assert.match(locate("http", "/send", "status", { equals: 200 }), /^http:\/send:status/);
});

test("a check is worded as an instruction the judge can act on", () => {
  const chain = worded(claim({ atLeast: 100 }, { because: "the operator holds 100 HBAR" }));
  assert.match(chain, /chain:accounts\/0\.0\.2:balance\.balance:atLeast=100/);
  assert.match(chain, /read accounts\/0\.0\.2 from the mirror node/);
  assert.match(chain, /balance\.balance should be at least 100/);
  assert.match(chain, /the spec: "the operator holds 100 HBAR"/, "the reading, so a wrong one can be seen");

  const page = worded({
    id: locate("dom", "/", "#balance", { equals: "42" }),
    kind: "dom",
    path: "/",
    field: "#balance",
    expect: { equals: "42" },
  });
  assert.match(page, /open \/ and read what #balance shows — it should equal "42"/);

  const route = worded({
    id: locate("http", "/status", "status", { equals: 200 }),
    kind: "http",
    path: "/status",
    field: "status",
    expect: { equals: 200 },
  });
  assert.match(route, /fetch \/status from the app — its status should equal 200/);
});

test("a verdict that accounts for every item stands", async () => {
  const checks = [claim({ atLeast: 100 })];
  const outcome = adjudicate(
    {
      verdict: verdict([
        { id: checks[0]!.id, before: "100", after: "102.5", holds: true, evidence: [MIRROR] },
      ]),
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(outcome.type, "verdict");
});

test("an item the judge skipped is not a verdict", async () => {
  const checks = [claim({ atLeast: 100 })];
  const outcome = adjudicate(
    { verdict: verdict([]), malformed: null },
    await workspace(),
    checks,
  );
  assert.equal(outcome.type, "no-verdict");
  assert.equal(outcome.type === "no-verdict" && outcome.why, "incomplete");
  assert.match(
    outcome.type === "no-verdict" ? outcome.reason : "",
    /does not account for every checklist item/,
  );
});

test("a chain claim without its before is a state, not a change", async () => {
  const checks = [claim({ atLeast: 100 })];
  const outcome = adjudicate(
    {
      verdict: verdict([{ id: checks[0]!.id, after: "102.5", holds: true, evidence: [MIRROR] }]),
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(outcome.type === "no-verdict" && outcome.why, "incomplete");
});

test("a page item needs no before — the app was already running", async () => {
  const checks: Check[] = [
    {
      id: locate("dom", "/", "#balance", { equals: "42" }),
      kind: "dom",
      path: "/",
      field: "#balance",
      expect: { equals: "42" },
    },
  ];
  const outcome = adjudicate(
    {
      verdict: verdict([
        { id: checks[0]!.id, after: "42", holds: true, evidence: ["shot.png"] },
      ]),
      malformed: null,
    },
    await workspace(["shot.png"]),
    checks,
  );
  assert.equal(outcome.type, "verdict");
});

test("a pass over a not-held item needs the judge's reason, out loud", async () => {
  const checks = [claim({ atLeast: 100 })];
  const silent = adjudicate(
    {
      verdict: verdict([
        { id: checks[0]!.id, before: "100", after: "50", holds: false, evidence: [MIRROR] },
      ]),
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(silent.type === "no-verdict" && silent.why, "incomplete");
  assert.match(silent.type === "no-verdict" ? silent.reason : "", /misread the spec/);

  const explained = adjudicate(
    {
      verdict: verdict([
        {
          id: checks[0]!.id,
          before: "100",
          after: "50",
          holds: false,
          evidence: [MIRROR],
          note: "the spec's 100 is the staking threshold, not the balance",
        },
      ]),
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(explained.type, "verdict", "the call is the judge's — made visibly");
});

test("a failing run needs no notes — the failure says enough", async () => {
  const checks = [claim({ atLeast: 100 })];
  const outcome = adjudicate(
    {
      verdict: {
        pass: false,
        failures: [{ what: "the transfer never lands", where: "/send", evidence: [MIRROR] }],
        verified: [
          { id: checks[0]!.id, before: "100", after: "100", holds: false, evidence: [MIRROR] },
        ],
      },
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(outcome.type, "verdict");
});

test("the accounting's evidence is checked like any other", async () => {
  const checks: Check[] = [
    {
      id: locate("dom", "/", "#balance", { equals: "42" }),
      kind: "dom",
      path: "/",
      field: "#balance",
      expect: { equals: "42" },
    },
  ];
  const outcome = adjudicate(
    {
      verdict: verdict([
        { id: checks[0]!.id, after: "42", holds: true, evidence: ["missing.png"] },
      ]),
      malformed: null,
    },
    await workspace(),
    checks,
  );
  assert.equal(outcome.type === "no-verdict" && outcome.why, "unevidenced");
});

test("no checklist, no accounting required", async () => {
  const outcome = adjudicate(
    { verdict: verdict([]), malformed: null },
    await workspace(),
    [],
  );
  assert.equal(outcome.type, "verdict");
});
