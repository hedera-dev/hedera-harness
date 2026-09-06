import { test } from "node:test";
import assert from "node:assert/strict";

import { runMirrorNodeValidation } from "../dist/validation/mirrorNode.js";

// These tests hit the real Hedera Mirror Node public REST endpoint on
// testnet. It's rate-limited but generous enough for a CI check + a
// handful of manual runs. Read-only, no HBAR spent.
//
// If Mirror is down (rare), skip rather than fail — the point of this
// validator is to be non-flaky when signal exists; transient outages
// are the mirror's problem, not the harness's.

const MIRROR_UP_PROBE = "https://testnet.mirrornode.hedera.com/api/v1/network/nodes?limit=1";

async function mirrorIsUp() {
  try {
    const r = await fetch(MIRROR_UP_PROBE, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

test("mirror-node validator — disabled runs are no-ops", async () => {
  const findings = await runMirrorNodeValidation({
    enabled: false,
    assertions: [
      { name: "unreachable", kind: "contract-exists", target: "0x0000000000000000000000000000000000000000" },
    ],
  });
  assert.deepEqual(findings, []);
});

test("mirror-node validator — empty assertions no-op", async () => {
  const findings = await runMirrorNodeValidation({ enabled: true, assertions: [] });
  assert.deepEqual(findings, []);
});

test("mirror-node validator — missing contract yields a finding", async (t) => {
  if (!(await mirrorIsUp())) return t.skip("mirror unreachable");
  const findings = await runMirrorNodeValidation({
    enabled: true,
    assertions: [
      {
        // Zero address — mirror returns 404, we expect the missing finding.
        name: "zero-addr contract not deployed",
        kind: "contract-exists",
        target: "0x0000000000000000000000000000000000000000",
      },
    ],
    timeoutMs: 4000,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "mirror-node-contract-missing");
});

test("mirror-node validator — real testnet account passes", async (t) => {
  if (!(await mirrorIsUp())) return t.skip("mirror unreachable");
  // Treasury account (0.0.2) is present on every Hedera network — as
  // reliable a "resource exists" fixture as we have. We use account-exists
  // rather than contract-exists because Hedera's low-id resources are
  // accounts, not contracts.
  const findings = await runMirrorNodeValidation({
    enabled: true,
    assertions: [{ name: "treasury account 0.0.2", kind: "account-exists", target: "0.0.2" }],
    timeoutMs: 4000,
  });
  assert.equal(findings.length, 0, `expected pass, got: ${JSON.stringify(findings)}`);
});

test("mirror-node validator — topic missing yields memo-agnostic finding", async (t) => {
  if (!(await mirrorIsUp())) return t.skip("mirror unreachable");
  const findings = await runMirrorNodeValidation({
    enabled: true,
    assertions: [
      // Extremely high topic id — guaranteed not to exist on testnet.
      { name: "phantom topic", kind: "topic-exists", target: "0.0.9999999999" },
    ],
    timeoutMs: 4000,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "mirror-node-topic-missing");
});
