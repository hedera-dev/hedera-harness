import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { classifyPrdContent, inspectWorkspacePrd } = await import(
  pathToFileURL(path.resolve("dist/prdStatus.js")).href
);

test("init skeleton prd.md is not a real PRD", async () => {
  const skeleton = await readFile(path.resolve("skeletons/project-harness/prd.md"), "utf8");
  assert.equal(classifyPrdContent(skeleton), "skeleton");
  assert.equal(classifyPrdContent("# Feature brief (edit me)\n"), "skeleton");
  assert.equal(classifyPrdContent(""), "skeleton");
});

test("a written brief is a real PRD", () => {
  assert.equal(
    classifyPrdContent("# Tip jar\n\nAdd a HashPack tip button on the home page.\n"),
    "real",
  );
});

test("inspectWorkspacePrd prefers a real increment under .harness/prds over the skeleton", async () => {
  const root = await makeTestTempDir("prd-increment-");
  await mkdir(path.join(root, ".harness", "prds"), { recursive: true });
  await writeFile(
    path.join(root, ".harness", "prd.md"),
    await readFile(path.resolve("skeletons/project-harness/prd.md"), "utf8"),
  );
  await writeFile(
    path.join(root, ".harness", "spec.yaml"),
    `name: demo
prd:
  - .harness/prd.md
  - .harness/prds/02-payment-history.md
`,
  );
  await writeFile(
    path.join(root, ".harness", "prds", "02-payment-history.md"),
    "# Payment history\n\nShow past HBAR sends on /payments.\n",
  );
  const status = inspectWorkspacePrd(root);
  assert.equal(status.kind, "real");
  assert.match(status.path ?? "", /02-payment-history/);
});

test("inspectWorkspacePrd treats missing and init template as interview-required", async () => {
  const root = await makeTestTempDir("prd-status-");
  assert.equal(inspectWorkspacePrd(root).kind, "missing");

  await mkdir(path.join(root, ".harness"), { recursive: true });
  await writeFile(
    path.join(root, ".harness", "prd.md"),
    await readFile(path.resolve("skeletons/project-harness/prd.md"), "utf8"),
  );
  const skeleton = inspectWorkspacePrd(root);
  assert.equal(skeleton.kind, "skeleton");
  assert.match(skeleton.reason, /edit me/i);
});
