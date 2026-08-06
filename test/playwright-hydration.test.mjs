import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const gate = await import(pathToFileURL(path.resolve("dist/validation/playwrightGate.js")).href);

test("isMeaningfulBodyText requires trimmed length", () => {
  assert.equal(gate.isMeaningfulBodyText("   "), false);
  assert.equal(gate.isMeaningfulBodyText("short"), false);
  assert.equal(gate.isMeaningfulBodyText("x".repeat(20)), true);
  assert.equal(gate.isMeaningfulBodyText("  Proof Wall pay-to-post  "), true);
});

test("waitForMeaningfulBodyText polls until body hydrates", async () => {
  let reads = 0;
  const page = {
    locator() {
      return {
        async innerText() {
          reads += 1;
          if (reads < 3) return "";
          return "Hedera Proof Wall with enough text";
        },
      };
    },
  };

  const result = await gate.waitForMeaningfulBodyText(page, {
    timeoutMs: 2_000,
    minLength: 20,
    pollMs: 20,
  });
  assert.equal(result.rendered, true);
  assert.match(result.bodyText, /Proof Wall/);
  assert.ok(reads >= 3);
});

test("waitForMeaningfulBodyText times out with last empty body", async () => {
  const page = {
    locator() {
      return {
        async innerText() {
          return "   ";
        },
      };
    },
  };

  const started = Date.now();
  const result = await gate.waitForMeaningfulBodyText(page, {
    timeoutMs: 120,
    minLength: 20,
    pollMs: 30,
  });
  assert.equal(result.rendered, false);
  assert.equal(result.bodyText, "");
  assert.ok(Date.now() - started >= 100);
});

test("waitForMeaningfulBodyText fails fast when server dies", async () => {
  let reads = 0;
  const page = {
    locator() {
      return {
        async innerText() {
          reads += 1;
          return "";
        },
      };
    },
  };

  const started = Date.now();
  await assert.rejects(
    () =>
      gate.waitForMeaningfulBodyText(page, {
        timeoutMs: 5_000,
        minLength: 20,
        pollMs: 20,
        isServerAlive: () => reads < 2,
      }),
    /Dev server exited while waiting for page hydration/,
  );
  assert.ok(Date.now() - started < 1_000);
  assert.ok(reads >= 1);
});
