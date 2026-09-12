import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { buildConsoleBaseline, newConsoleErrors, normalizeConsoleError } = await import(
  pathToFileURL(path.resolve("dist/validation/consoleBaseline.js")).href
);

test("normalizing hides the parts that change between two boots", () => {
  const first = normalizeConsoleError(
    "Failed to load resource: the server responded with 503 (http://localhost:3137/api/price?t=1789119464)",
  );
  const second = normalizeConsoleError(
    "Failed to load resource: the server responded with 503 (http://localhost:52100/api/price?t=1789119999)",
  );
  assert.equal(first, second, "a fresh port and timestamp must not read as a new error");
  assert.notEqual(
    normalizeConsoleError("Failed to fetch HBAR price"),
    normalizeConsoleError("Failed to fetch token list"),
    "genuinely different failures must stay different",
  );
});

test("noise the app already logged is not charged to the agent", () => {
  const baseline = buildConsoleBaseline([
    { name: "home", consoleErrors: ["Failed to fetch HBAR price: TypeError: Failed to fetch"] },
  ]);

  assert.deepEqual(
    newConsoleErrors("home", ["Failed to fetch HBAR price: TypeError: Failed to fetch"], baseline),
    [],
  );
  assert.deepEqual(
    newConsoleErrors("home", ["Hydration failed: text content did not match"], baseline),
    ["Hydration failed: text content did not match"],
    "a genuinely new error must still fail the route",
  );
});

test("app-wide noise carries onto a route the agent just created", () => {
  // The route had no baseline of its own: it did not exist yet. Without this
  // every new page would fail on whatever the shared layout logs.
  const baseline = buildConsoleBaseline([
    { name: "home", consoleErrors: ["Failed to load resource: net::ERR_INTERNET_DISCONNECTED"] },
  ]);

  assert.deepEqual(
    newConsoleErrors("about", ["Failed to load resource: net::ERR_INTERNET_DISCONNECTED"], baseline),
    [],
  );
  assert.deepEqual(newConsoleErrors("about", ["ReferenceError: about is not defined"], baseline), [
    "ReferenceError: about is not defined",
  ]);
});

test("with no baseline every error still counts", () => {
  assert.deepEqual(newConsoleErrors("home", ["boom"], undefined), ["boom"]);
});
