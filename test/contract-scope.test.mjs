import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const scope = await import(pathToFileURL(path.resolve("dist/contractScope.js")).href);

test("parseContractScopeLine reads the tasks/PRD header", () => {
  assert.equal(scope.parseContractScopeLine("Contracts: none\n"), "none");
  assert.equal(scope.parseContractScopeLine("# Tasks\nContracts: solidity\n"), "solidity");
  assert.equal(scope.parseContractScopeLine("# Tasks\n- [ ] T1: x\n"), undefined);
});

test("inferContractScope defaults to none for payments and HCS", () => {
  assert.equal(scope.inferContractScope("Add a RainbowKit send HBAR history page.\n"), "none");
  assert.equal(
    scope.inferContractScope("Submit messages to an HCS topic. No smart contracts.\n"),
    "none",
  );
  assert.equal(
    scope.inferContractScope("create-scaffold-hbar.capabilities.solidityFramework: none\nNo Hardhat.\n"),
    "none",
  );
});

test("inferContractScope is solidity only on positive contract signals", () => {
  assert.equal(scope.inferContractScope("Call the HTS precompile at 0x167.\n"), "solidity");
  assert.equal(scope.inferContractScope("Validation: yarn hardhat:compile must pass.\n"), "solidity");
  assert.equal(
    scope.inferContractScope("create-scaffold-hbar.capabilities.solidityFramework: hardhat\n"),
    "solidity",
  );
});

test("hardhatGate follows contract scope", () => {
  assert.equal(scope.hardhatGate("none"), "skip");
  assert.equal(scope.hardhatGate("solidity"), "run");
});
