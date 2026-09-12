import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeTestTempDir } from "./tmpDir.mjs";

const { runChainDeploy } = await import(
  pathToFileURL(path.resolve("dist/attemptStages.js")).href
);

/**
 * Characterization test for a real gap, not a bug: `runChainDeploy` (the only code path that
 * runs during the CHAIN-capable part of SMOKE before EVALUATE) has exactly one signal per
 * command — its exit code. It has no way to observe what the command actually did on-chain.
 *
 * A deploy step can succeed (exit 0) while the thing it deployed violates the recipe's
 * intended policy (e.g. an unverified investor can receive a regulated asset it should be
 * rejected for) — and today that produces zero findings. If `eval` isn't configured for the
 * recipe (the README frames EVALUATE as an incremental add-on: "start at the bottom, add a
 * stage when the one below stops catching your failures"), nothing downstream ever checks
 * on-chain behavior either, so the attempt is reported PASSED.
 *
 */
test("a chain-deploy command that exits 0 produces no findings for an undeclared policy", async () => {
  const workspacePath = await makeTestTempDir("chain-postcondition-gap-");

  const fakeChainSigner = {
    accountId: "0.0.1234",
    privateKeyHex: `0x${"a".repeat(64)}`,
    evmAddress: `0x${"1".repeat(40)}`,
    network: "testnet",
  };

  const context = {
    attempt: 1,
    workspacePath,
    chainSigner: fakeChainSigner,
    spec: {
      chainValidation: {
        enabled: true,
        network: "testnet",
        deploy: {
          commands: [
            {
              // Stands in for: "deploy the bond contract, then attempt a transfer to an
              // unverified investor that the policy says must be rejected." Both steps
              // succeed at the shell level, so the deploy command exits 0 regardless of
              // whether the policy held.
              name: "deploy-and-attempt-forbidden-transfer",
              command: `"${process.execPath}" -e ""`,
            },
          ],
        },
        expose: { envVars: [] },
      },
    },
  };

  const findings = await runChainDeploy(context);

  assert.deepEqual(
    findings,
    [],
    "runChainDeploy only inspects exitCode — a real policy violation with exit 0 is invisible to it",
  );
});

test("runChainDeploy reports command failure without a policy-outcome verdict", async () => {
  const workspacePath = await makeTestTempDir("chain-postcondition-gap-");

  const context = {
    attempt: 1,
    workspacePath,
    chainSigner: {
      accountId: "0.0.1234",
      privateKeyHex: `0x${"a".repeat(64)}`,
      evmAddress: `0x${"1".repeat(40)}`,
      network: "testnet",
    },
    spec: {
      chainValidation: {
        enabled: true,
        network: "testnet",
        deploy: { commands: [{ name: "broken-shell-step", command: `"${process.execPath}" -e "process.exit(1)"` }] },
        expose: { envVars: [] },
      },
    },
  };

  const findings = await runChainDeploy(context);

  assert.equal(findings.length, 1);
  // category "commands" is the same bucket a broken `yarn build` lands in — there is no
  // category that distinguishes "the shell step crashed" from "the on-chain outcome was wrong,"
  // and no `expect`/`observed` evidence shape at all (see ValidationFinding in src/types.ts).
  assert.equal(findings[0].category, "commands");
  assert.equal("expect" in findings[0], false);
  assert.equal("observed" in findings[0], false);
});

test("a genuinely unspawnable deploy command is a commands finding, not an uncaught crash", async () => {
  // executeCommand's promise can reject outright (child-process "error" event), not just
  // resolve with a non-zero exit -- a nonexistent cwd reliably triggers this even with
  // shell:true (the shell itself can't be spawned into a directory that doesn't exist).
  const context = {
    attempt: 1,
    workspacePath: path.resolve(".tmp-test/does-not-exist/deploy-gap"),
    chainSigner: {
      accountId: "0.0.1234",
      privateKeyHex: `0x${"a".repeat(64)}`,
      evmAddress: `0x${"1".repeat(40)}`,
      network: "testnet",
    },
    spec: {
      chainValidation: {
        enabled: true,
        network: "testnet",
        deploy: { commands: [{ name: "unspawnable-step", command: "echo hi" }] },
        expose: { envVars: [] },
      },
    },
  };

  const findings = await runChainDeploy(context);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "commands");
  assert.match(findings[0].message, /could not be started/);
});
