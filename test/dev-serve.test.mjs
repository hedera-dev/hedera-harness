import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import path from "node:path";

const cli = await import(pathToFileURL(path.resolve("dist/cli.js")).href);
const serve = await import(pathToFileURL(path.resolve("dist/devServe.js")).href);

test("parseCliArgs accepts serve start stop status", () => {
  const start = cli.parseCliArgs(["serve", "start", "--workspace", "D:\\app"]);
  assert.equal(start.command, "serve");
  assert.equal(start.serveOptions?.subcommand, "start");
  assert.equal(start.serveOptions?.workspace, "D:\\app");

  const stop = cli.parseCliArgs(["serve", "stop"]);
  assert.equal(stop.serveOptions?.subcommand, "stop");

  const status = cli.parseCliArgs(["serve", "status"]);
  assert.equal(status.serveOptions?.subcommand, "status");
});

test("commandLineLooksLikeWorkspaceNextDev matches this app's next dev only", () => {
  const ws = "C:/Users/halli/app/test-app";
  assert.equal(
    serve.commandLineLooksLikeWorkspaceNextDev(
      `"node.exe" C:/Users/halli/app/test-app/packages/nextjs/node_modules/next/dist/bin/next "dev" "-p" "3001"`,
      ws,
    ),
    true,
  );
  assert.equal(
    serve.commandLineLooksLikeWorkspaceNextDev(
      `yarn next:dev`,
      ws,
    ),
    false,
  );
  assert.equal(
    serve.commandLineLooksLikeWorkspaceNextDev(
      `"node.exe" C:/Users/halli/app/test-app/packages/nextjs/node_modules/next/dist/bin/next build`,
      ws,
    ),
    false,
  );
  assert.equal(
    serve.commandLineLooksLikeWorkspaceNextDev(
      `"node.exe" C:/other/app/packages/nextjs/node_modules/next/dist/bin/next "dev"`,
      ws,
    ),
    false,
  );
});

test("formatDevServeReport is secret-free", () => {
  const text = serve.formatDevServeReport({
    action: "start",
    running: true,
    reused: true,
    url: "http://127.0.0.1:3000",
    pid: 12,
    cssOk: true,
    killed: 1,
    note: "Reused",
  });
  assert.match(text, /dev=running/);
  assert.match(text, /reused=true/);
  assert.match(text, /killed=1/);
  assert.doesNotMatch(text, /0x[a-f0-9]{64}/i);
});
