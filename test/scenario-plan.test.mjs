import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const plan = await import(pathToFileURL(path.resolve("dist/scenario/plan.js")).href);
const mirror = await import(pathToFileURL(path.resolve("dist/scenario/mirror.js")).href);

test("parseScenarioPlan accepts a two-actor airdrop script", () => {
  const parsed = plan.parseScenarioPlan(
    {
      actors: { alice: { fundHbar: 5 }, bob: { fundHbar: 2 } },
      steps: [
        { id: "gold", actor: "alice", tokenCreate: { name: "GOLD", symbol: "GOLD" } },
        { id: "drop", actor: "alice", tokenAirdrop: { token: "gold", to: "bob", amount: 10 } },
      ],
      assert: [{ tokenBalance: { actor: "bob", token: "gold", min: 10 } }],
    },
    "test",
  );
  assert.equal(Object.keys(parsed.actors).length, 2);
  assert.equal(parsed.steps[0].id, "gold");
  assert.equal(parsed.assertions.length, 1);
});

test("parseScenarioPlan rejects an unknown actor", () => {
  assert.throws(
    () =>
      plan.parseScenarioPlan(
        {
          actors: { alice: { fundHbar: 1 } },
          steps: [{ actor: "bob", transferHbar: { to: "alice", hbar: 1 } }],
        },
        "test",
      ),
    /not in actors/,
  );
});

test("parseScenarioPlan rejects a step with no known action", () => {
  assert.throws(
    () =>
      plan.parseScenarioPlan(
        { actors: { alice: { fundHbar: 1 } }, steps: [{ actor: "alice", wave: true }] },
        "test",
      ),
    /must be one of/,
  );
});

test("mirror parsers read live-shaped payloads", () => {
  assert.equal(mirror.parseAccountHbar({ balance: { balance: 250_000_000 } }), 2.5);
  assert.equal(
    mirror.parseTokenBalance({ tokens: [{ token_id: "0.0.9", balance: 40 }] }, "0.0.9"),
    40,
  );
  const encoded = Buffer.from("paid", "utf8").toString("base64");
  assert.equal(mirror.parseTopicContains({ messages: [{ message: encoded }] }, "paid"), true);
  assert.deepEqual(
    mirror.parsePendingAirdrop(
      { airdrops: [{ token_id: "0.0.9", sender_id: "0.0.2" }] },
      "0.0.9",
    ),
    { senderId: "0.0.2", tokenId: "0.0.9" },
  );
});
