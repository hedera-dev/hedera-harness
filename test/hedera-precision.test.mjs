import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { scanForHederaPrecisionRisks } = await import(
  pathToFileURL(path.resolve("dist/validation/hederaPrecision.js")).href
);

// Mirrors the real bug this check is modeled on: a Hedera testnet oracle
// contract forwarding `msg.value - fee` as a refund. On Hedera, wei below
// 1e10 (1 tinybar) rounds to zero on the real transfer, so a sub-tinybar
// refund silently vanishes instead of reaching the caller.
const UNROUNDED_REFUND = `
pragma solidity ^0.8.19;

contract Oracle {
    function updatePriceFeeds(bytes[] calldata data) external payable {
        uint256 fee = pyth.getUpdateFee(data);
        require(msg.value >= fee, "insufficient fee");
        pyth.updatePriceFeeds{value: fee}(data);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "refund failed");
        }
    }
}
`;

const ROUNDED_REFUND = `
pragma solidity ^0.8.19;

contract Oracle {
    uint256 internal constant TINYBAR_IN_WEI = 1e10;

    function _roundUpToTinybar(uint256 amount) internal pure returns (uint256) {
        if (amount == 0) return 0;
        return ((amount + TINYBAR_IN_WEI - 1) / TINYBAR_IN_WEI) * TINYBAR_IN_WEI;
    }

    function updatePriceFeeds(bytes[] calldata data) external payable {
        uint256 fee = _roundUpToTinybar(pyth.getUpdateFee(data));
        require(msg.value >= fee, "insufficient fee");
        pyth.updatePriceFeeds{value: fee}(data);
        if (msg.value > fee) {
            (bool ok, ) = msg.sender.call{value: msg.value - fee}("");
            require(ok, "refund failed");
        }
    }
}
`;

const NO_VALUE_FORWARD = `
pragma solidity ^0.8.19;

contract PlainToken {
    mapping(address => uint256) public balances;

    function transfer(address to, uint256 amount) external returns (bool) {
        balances[msg.sender] -= amount;
        balances[to] += amount;
        return true;
    }
}
`;

test("flags a native-value refund forwarded without a tinybar-rounding safeguard", async () => {
  const dir = await makeTestTempDir("hedera-precision-bad-");
  await mkdir(path.join(dir, "contracts"), { recursive: true });
  await writeFile(path.join(dir, "contracts", "Oracle.sol"), UNROUNDED_REFUND);

  const findings = await scanForHederaPrecisionRisks(dir);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "hedera-precision");
  assert.match(findings[0].id, /contracts\/Oracle\.sol/);
});

test("does not flag the same pattern once a tinybar-rounding safeguard is present", async () => {
  const dir = await makeTestTempDir("hedera-precision-good-");
  await mkdir(path.join(dir, "contracts"), { recursive: true });
  await writeFile(path.join(dir, "contracts", "Oracle.sol"), ROUNDED_REFUND);

  const findings = await scanForHederaPrecisionRisks(dir);

  assert.deepEqual(findings, []);
});

test("does not flag ordinary arithmetic with no value-transfer call", async () => {
  const dir = await makeTestTempDir("hedera-precision-none-");
  await mkdir(path.join(dir, "contracts"), { recursive: true });
  await writeFile(path.join(dir, "contracts", "PlainToken.sol"), NO_VALUE_FORWARD);

  const findings = await scanForHederaPrecisionRisks(dir);

  assert.deepEqual(findings, []);
});

test("ignores non-Solidity files and skipped directories", async () => {
  const dir = await makeTestTempDir("hedera-precision-skip-");
  await mkdir(path.join(dir, "node_modules", "somepkg"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "somepkg", "Oracle.sol"), UNROUNDED_REFUND);
  await writeFile(path.join(dir, "notes.md"), UNROUNDED_REFUND);

  const findings = await scanForHederaPrecisionRisks(dir);

  assert.deepEqual(findings, []);
});
