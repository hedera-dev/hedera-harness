import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const {
  allEvalPaths,
  selectActiveSlice,
  specHasEval,
} = await import(pathToFileURL(path.resolve("dist/sliceSelection.js")).href);

test("specHasEval and allEvalPaths reflect absent, scalar, and list config", () => {
  assert.equal(specHasEval({}), false);
  assert.equal(specHasEval({ evalPaths: undefined }), false);
  assert.equal(specHasEval({ evalPaths: [] }), false);
  assert.equal(specHasEval({ evalPaths: ["/a/eval.json"] }), true);

  assert.deepEqual(allEvalPaths({}), []);
  assert.deepEqual(allEvalPaths({ evalPaths: ["/a.json", "/b.json"] }), ["/a.json", "/b.json"]);
});

test("scalar eval (length 1) is reused for every slice index", () => {
  const spec = {
    prdPaths: ["/p0.md", "/p1.md", "/p2.md"],
    evalPaths: ["/shared/eval.json"],
  };

  for (let i = 0; i < 3; i += 1) {
    const active = selectActiveSlice(spec, i);
    assert.equal(active.index, i);
    assert.equal(active.count, 3);
    assert.equal(active.prdPath, spec.prdPaths[i]);
    assert.equal(active.evalPath, "/shared/eval.json");
  }
});

test("list eval is 1:1 with prdPaths by index", () => {
  const spec = {
    prdPaths: ["/p0.md", "/p1.md"],
    evalPaths: ["/e0.json", "/e1.json"],
  };

  assert.deepEqual(selectActiveSlice(spec, 0), {
    index: 0,
    count: 2,
    prdPath: "/p0.md",
    evalPath: "/e0.json",
  });
  assert.deepEqual(selectActiveSlice(spec, 1), {
    index: 1,
    count: 2,
    prdPath: "/p1.md",
    evalPath: "/e1.json",
  });
});

test("absent eval yields undefined evalPath", () => {
  const active = selectActiveSlice({ prdPaths: ["/only.md"] }, 0);
  assert.equal(active.prdPath, "/only.md");
  assert.equal(active.evalPath, undefined);
});

test("selectActiveSlice throws on out-of-range index", () => {
  const spec = { prdPaths: ["/a.md", "/b.md"] };
  assert.throws(() => selectActiveSlice(spec, -1), /out of range/);
  assert.throws(() => selectActiveSlice(spec, 2), /out of range/);
});
