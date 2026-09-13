import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { makeTestTempDir } from "./tmpDir.mjs";

const contract = await import(pathToFileURL(path.resolve("dist/e2eContract.js")).href);

test("missing contract falls back to the seed payments form", async () => {
  const root = await makeTestTempDir("e2e-contract-missing-");
  const status = contract.inspectE2eContract(root);
  assert.equal(status.kind, "missing");
  assert.equal(status.contract.route, "/payments");
  assert.equal(status.contract.amountTestId, "pay-amount");
  const report = contract.formatE2eContract(status);
  assert.match(report, /e2e_contract=missing/);
  assert.match(report, /harness_e2e_contract action=set/);
});

test("set then status round-trips any app route and testids", async () => {
  const root = await makeTestTempDir("e2e-contract-set-");
  const written = contract.writeE2eContract(root, {
    route: "/",
    toTestId: "usdc-destination",
    amountTestId: "usdc-amount",
    submitTestId: "usdc-send",
    txHashTestId: "usdc-tx-hash",
    submitLabel: "send usdc|send",
    confirmations: 2,
    defaultAmount: "0.5",
  });
  assert.equal(written.kind, "ready");

  const raw = JSON.parse(await readFile(contract.e2eContractPath(root), "utf8"));
  assert.equal(raw.route, "/");
  assert.equal(raw.confirmations, 2);

  const status = contract.inspectE2eContract(root);
  assert.equal(status.kind, "ready");
  assert.equal(status.contract.toTestId, "usdc-destination");
  assert.equal(status.contract.defaultAmount, "0.5");
  const report = contract.formatE2eContract(status);
  assert.match(report, /route=\//);
  assert.match(report, /submit_testid=usdc-send/);
  assert.match(report, /confirmations=2/);
});

test("snake_case keys from the agent are accepted and gaps are reported", async () => {
  const root = await makeTestTempDir("e2e-contract-snake-");
  const ok = contract.writeE2eContract(root, {
    route: "/mint",
    to_testid: "mint-to",
    amount_testid: "mint-amount",
    submit_testid: "mint-submit",
  });
  assert.equal(ok.kind, "ready");
  assert.equal(ok.contract.txHashTestId, "mint-submit-hash");
  assert.equal(ok.contract.confirmations, 1);

  const bad = contract.writeE2eContract(root, { route: "mint", toTestId: "mint-to" });
  assert.equal(bad.kind, "invalid");
  assert.match(contract.formatE2eContract(bad), /problem=/);
  // A rejected set must not clobber the good contract on disk.
  assert.equal(contract.inspectE2eContract(root).contract.route, "/mint");
});

test("a field resolves by data-testid, id, or name", () => {
  const selector = contract.fieldSelector("usdc-amount");
  assert.match(selector, /\[data-testid="usdc-amount"\]/);
  assert.match(selector, /#usdc-amount/);
  assert.match(selector, /\[name="usdc-amount"\]/);
  // A value that cannot be a bare CSS id must not emit a broken `#…`.
  assert.doesNotMatch(contract.fieldSelector("2 amount"), /#/);
});

test("runner joins the contract route onto the live app url", async () => {
  const e2e = await import(pathToFileURL(path.resolve("dist/walletE2e.js")).href);
  assert.equal(e2e.joinRoute("http://127.0.0.1:3000", "/"), "http://127.0.0.1:3000");
  assert.equal(e2e.joinRoute("http://127.0.0.1:3000/", "/payments"), "http://127.0.0.1:3000/payments");
  assert.equal(e2e.joinRoute("http://127.0.0.1:3003", "mint"), "http://127.0.0.1:3003/mint");
});

test("contract default amount wins over the hardcoded HBAR smoke amount", async () => {
  const e2e = await import(pathToFileURL(path.resolve("dist/walletE2e.js")).href);
  assert.equal(e2e.normalizeE2eAmount(undefined, "0.5").amount, "0.5");
  assert.equal(e2e.normalizeE2eAmount("nope", "0.5").amount, "0.5");
  assert.equal(e2e.normalizeE2eAmount("2", "0.5").amount, "2");
});

test("wallet runner no longer hardcodes the payments route", async () => {
  const source = await readFile(path.resolve("src/walletE2e.ts"), "utf8");
  assert.doesNotMatch(source, /\/payments`/);
  assert.match(source, /inspectE2eContract/);
});
