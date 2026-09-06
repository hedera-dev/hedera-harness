import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { assessOperatorFunding, FEE_MARGIN_HBAR, COMFORTABLE_RUNS } = await import(
  pathToFileURL(path.resolve("dist/validation/chainFunding.js")).href
);

const config = { fundingHbar: 10 };

test("a balance that cannot cover one run fails before the run starts", () => {
  const assessment = assessOperatorFunding(10, config); // 10 funded + 1 fee margin > 10
  assert.equal(assessment.verdict, "insufficient");
  assert.equal(assessment.runsAffordable, 0);
  assert.match(assessment.fix, /portal\.hedera\.com\/faucet/);
  assert.match(assessment.fix, /after baseline installs and builds/);
});

test("a balance for fewer than a few runs warns rather than fails", () => {
  const assessment = assessOperatorFunding(2 * (config.fundingHbar + FEE_MARGIN_HBAR), config);
  assert.equal(assessment.verdict, "low");
  assert.equal(assessment.runsAffordable, 2);
  assert.match(assessment.detail, /2 runs/);
});

test("a comfortable balance passes and reports how many runs it buys", () => {
  const assessment = assessOperatorFunding(COMFORTABLE_RUNS * (config.fundingHbar + FEE_MARGIN_HBAR), config);
  assert.equal(assessment.verdict, "ok");
  assert.equal(assessment.runsAffordable, COMFORTABLE_RUNS);
  assert.equal(assessment.fix, undefined);
});

test("a deploying recipe is told that funding must cover the reserved gas, not the charged fee", () => {
  const plain = assessOperatorFunding(100, config);
  const deploying = assessOperatorFunding(100, { ...config, deploy: { contractsDir: "contracts" } });
  assert.equal(plain.verdict, "ok");
  assert.doesNotMatch(plain.detail, /gasLimit/);
  assert.match(deploying.detail, /gasLimit × gasPrice/);
});

test("the fee margin is counted, so exactly fundingHbar is not enough", () => {
  assert.equal(assessOperatorFunding(config.fundingHbar, config).verdict, "insufficient");
  assert.equal(assessOperatorFunding(config.fundingHbar + FEE_MARGIN_HBAR, config).runsAffordable, 1);
});
