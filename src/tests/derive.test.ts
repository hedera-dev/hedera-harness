import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readChecks } from "../derive.js";
import { missingSkill } from "../evaluate.js";

/**
 * The distinction this file exists for.
 *
 * A checklist of none and a derivation that broke used to be the same empty
 * array, so a run whose derivation timed out reported PASSED exactly like one
 * where eight checks held. Nothing mechanical had stood behind it and nothing
 * said so — the only failure in the harness that was invisible by default.
 */
async function wrote(contents: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-derive-test-"));
  const target = join(dir, "checks.json");
  if (contents !== null) await writeFile(target, contents);
  return target;
}

const ONE = {
  kind: "http",
  path: "/status",
  field: "status",
  expect: { equals: 200 },
  because: "the page at /status returns 200",
};

test("no checklist at all is a failure, not an empty one", async () => {
  const absent = await readChecks(await wrote(null));
  assert.ok("failed" in absent, "a file that was never written");

  const garbage = await readChecks(await wrote("I could not determine any checks."));
  assert.ok("failed" in garbage, "prose where JSON was asked for");

  const wrongShape = await readChecks(await wrote('{"checks": []}'));
  assert.ok("failed" in wrongShape, "an object where a list was asked for");
});

test("an empty list is a real answer — most specs are mostly judgement", async () => {
  const found = await readChecks(await wrote("[]"));
  assert.deepEqual(found, { checks: [], dropped: 0 });
});

test("unusable entries are counted, not silently dropped", async () => {
  const found = await readChecks(
    await wrote(
      JSON.stringify([
        ONE,
        { ...ONE, kind: "telepathy" },
        { ...ONE, expect: { equals: 200, contains: "ok" } },
        { ...ONE, because: "" },
        { ...ONE, path: "" },
      ]),
    ),
  );
  assert.ok(!("failed" in found));
  assert.equal(found.checks.length, 1, "only the usable one survives");
  assert.equal(found.dropped, 4, "and the rest are reported rather than vanishing");
});

test("two expectations in one entry are two claims wearing one locator", async () => {
  // The identity a failure hashes covers one expectation, so a check carrying
  // two would report the wrong thing as fixed.
  const found = await readChecks(await wrote(JSON.stringify([{ ...ONE, expect: {} }])));
  assert.ok(!("failed" in found) && found.checks.length === 0 && found.dropped === 1);
});

/**
 * The guard on the evaluator's one skill.
 *
 * `tools:playwright-cli` is a name assembled from a folder Playwright owns, so
 * it can drift three ways — the folder moves, a plugin manifest appears, or the
 * skill is renamed. None of those raise anything: the filter simply matches
 * nothing and the evaluator judges with no browser skill. This is what makes
 * that loud.
 */
test("a browser skill that did not load says so", () => {
  const init = (skills: string[]) =>
    ({ type: "system", subtype: "init", skills }) as unknown as Parameters<typeof missingSkill>[0];

  assert.equal(missingSkill(init(["tools:playwright-cli", "dataviz"])), null, "loaded");

  assert.match(
    missingSkill(init(["playwright:playwright-cli"])) ?? "",
    /not tools:playwright-cli/,
    "a manifest renamed the plugin — the near-miss is named, since that is the fix",
  );
  assert.match(
    missingSkill(init(["dataviz", "code-review"])) ?? "",
    /never taught to use/,
    "gone entirely",
  );
  assert.equal(
    missingSkill({ type: "assistant" } as unknown as Parameters<typeof missingSkill>[0]),
    null,
    "every other message is not an answer to this question",
  );
});
