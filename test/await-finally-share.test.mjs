import assert from "node:assert/strict";
import test from "node:test";

/**
 * Regression for shared SMOKE→EVALUATE server teardown.
 *
 * In an async function, `return promise` (no await) inside try/finally runs
 * `finally` as soon as the promise is *returned*, before it settles — so a
 * `devServer.stop()` in finally kills the server before EVALUATE. `return await`
 * keeps the server alive until the inner work finishes.
 */
test("return await keeps shared resource alive until work finishes", async () => {
  let stopped = false;

  async function buggyShare() {
    try {
      return Promise.resolve().then(async () => {
        await new Promise(r => setTimeout(r, 20));
        return { aliveDuringWork: !stopped };
      });
    } finally {
      stopped = true;
    }
  }

  stopped = false;
  async function fixedShare() {
    try {
      return await Promise.resolve().then(async () => {
        await new Promise(r => setTimeout(r, 20));
        return { aliveDuringWork: !stopped };
      });
    } finally {
      stopped = true;
    }
  }

  assert.equal((await buggyShare()).aliveDuringWork, false);
  stopped = false;
  assert.equal((await fixedShare()).aliveDuringWork, true);
});
