import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { computeFindingDelta, applyFindingStatus, formatFindingDelta, findingIds } = await import(
  pathToFileURL(path.resolve("dist/findingsLifecycle.js")).href
);

const finding = (id, message = id) => ({ id, category: "static", message });

test("findingIds deduplicates repeated ids", () => {
  assert.deepEqual(findingIds([finding("a"), finding("b"), finding("a")]), ["a", "b"]);
});

test("computeFindingDelta separates open, fixed and introduced", () => {
  const delta = computeFindingDelta(["a", "b"], [finding("b"), finding("c")]);

  assert.deepEqual(delta.open, ["b", "c"]);
  assert.deepEqual(delta.fixed, ["a"]);
  assert.deepEqual(delta.introduced, ["c"]);
});

test("computeFindingDelta on the first attempt treats everything as introduced", () => {
  const delta = computeFindingDelta([], [finding("a"), finding("b")]);

  assert.deepEqual(delta.open, ["a", "b"]);
  assert.deepEqual(delta.fixed, []);
  assert.deepEqual(delta.introduced, ["a", "b"]);
});

test("computeFindingDelta reports a fully cleared attempt", () => {
  const delta = computeFindingDelta(["a", "b"], []);

  assert.deepEqual(delta.open, []);
  assert.deepEqual(delta.fixed, ["a", "b"]);
  assert.deepEqual(delta.introduced, []);
});

test("applyFindingStatus marks current findings open and carries fixed ones forward", () => {
  const previous = [finding("a", "was broken"), finding("b")];
  const current = [finding("b"), finding("c")];
  const delta = computeFindingDelta(["a", "b"], current);

  const stamped = applyFindingStatus(current, delta, previous);

  assert.deepEqual(
    stamped.filter(f => f.status === "open").map(f => f.id),
    ["b", "c"],
  );
  const fixed = stamped.filter(f => f.status === "fixed");
  assert.deepEqual(fixed.map(f => f.id), ["a"]);
  // The carried finding keeps its original message so a report can explain what closed.
  assert.equal(fixed[0].message, "was broken");
});

test("applyFindingStatus does not duplicate a finding repeated across prior attempts", () => {
  const previous = [finding("a"), finding("a"), finding("b")];
  const delta = computeFindingDelta(["a", "b"], [finding("b")]);

  const stamped = applyFindingStatus([finding("b")], delta, previous);

  assert.equal(stamped.filter(f => f.id === "a").length, 1);
});

test("formatFindingDelta summarises convergence", () => {
  assert.equal(formatFindingDelta({ open: [], fixed: [], introduced: [] }), "no findings");
  assert.equal(
    formatFindingDelta({ open: ["a"], fixed: ["b", "c"], introduced: ["a"] }),
    "1 open, 2 fixed, 1 new",
  );
  assert.equal(formatFindingDelta({ open: ["a", "b"], fixed: [], introduced: [] }), "2 open");
});
