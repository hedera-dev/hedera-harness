import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { makeOsTempDir } from "./tmpDir.mjs";

const { executeCommand } = await import(pathToFileURL(path.resolve("dist/command.js")).href);
const { createDevServerSession } = await import(
  pathToFileURL(path.resolve("dist/validation/devServer.js")).href
);

/** True while the pid exists. Signal 0 checks liveness without delivering anything. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

// These drive real child processes, so they are slower than the unit tests.
// They cover the one thing unit tests cannot: that a timeout actually kills.

test("executeCommand escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const dir = await makeOsTempDir("harness-sigterm-");
  const pidFile = path.join(dir, "shell.pid");

  const result = await executeCommand({
    // Traps and discards SIGTERM: before the escalation fix this never settled.
    command: `echo $$ > "${pidFile}"; trap '' TERM; sleep 30`,
    cwd: dir,
    shell: true,
    timeoutMs: 1_000,
  });

  assert.equal(result.timedOut, true, "should report a timeout");

  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(pid), "shell should have written its pid");
  assert.ok(await waitForDeath(pid), `shell ${pid} should have been killed`);
});

test("executeCommand timeout kills grandchildren, not just the shell", async () => {
  const dir = await makeOsTempDir("harness-tree-");
  const childPidFile = path.join(dir, "child.pid");

  const result = await executeCommand({
    // `sleep` here stands in for yarn/next: signalling only `sh` would orphan it.
    command: `sleep 30 & echo $! > "${childPidFile}"; wait`,
    cwd: dir,
    shell: true,
    timeoutMs: 1_500,
  });

  assert.equal(result.timedOut, true);

  const childPid = Number.parseInt((await readFile(childPidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(childPid), "background job should have written its pid");
  assert.ok(await waitForDeath(childPid), `grandchild ${childPid} should have been killed`);
});

test("executeCommand returns normally for a command that exits on its own", async () => {
  const dir = await makeOsTempDir("harness-normal-");

  const result = await executeCommand({
    command: `echo hello`,
    cwd: dir,
    shell: true,
    timeoutMs: 10_000,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello/);
});

test("createDevServerSession tears down the server when readiness fails", async () => {
  const dir = await makeOsTempDir("harness-devserver-");
  const pidFile = path.join(dir, "server.pid");

  // Reports a Local URL so detection succeeds, but never listens — so the
  // readiness probe fails while the process is still running. Before the fix
  // this left the process group alive holding the port.
  await assert.rejects(
    () =>
      createDevServerSession(
        dir,
        {
          command: `echo $$ > "${pidFile}"; echo "Local: http://127.0.0.1:1"; sleep 30`,
          configuredUrl: "http://127.0.0.1:1",
          timeoutMs: 1_500,
        },
        "test",
      ),
    /did not become ready/,
  );

  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(pid), "server should have written its pid");
  assert.ok(await waitForDeath(pid), `dev server ${pid} should have been torn down`);
});

test("createDevServerSession happy path stops the process group", async () => {
  const dir = await makeOsTempDir("harness-devserver-ok-");
  const pidFile = path.join(dir, "server.pid");
  const serverScript = path.join(dir, "server.mjs");

  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  console.log("Local: http://127.0.0.1:" + server.address().port);
});
`,
  );

  const session = await createDevServerSession(
    dir,
    {
      command: `node ${JSON.stringify(serverScript)}`,
      configuredUrl: "http://127.0.0.1:0",
      timeoutMs: 10_000,
    },
    "test",
  );

  assert.match(session.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(session.isAlive(), true);

  const pid = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
  assert.ok(Number.isInteger(pid));

  await session.stop();
  assert.ok(await waitForDeath(pid), `dev server ${pid} should have been stopped`);
  assert.equal(session.isAlive(), false);
});

test("createDevServerSession is the only lifecycle entry callers need", async () => {
  const mod = await import(pathToFileURL(path.resolve("dist/validation/devServer.js")).href);
  assert.equal(typeof mod.createDevServerSession, "function");
  assert.equal(typeof mod.loadDevServerConfig, "function");
  assert.equal(mod.startDevServer, undefined, "startDevServer must stay module-private");
  assert.equal(mod.waitForServer, undefined, "waitForServer must stay module-private");
  assert.equal(mod.stopDevServer, undefined, "stopDevServer must stay module-private");
});

/** `count` distinct free loopback ports: bind them all before releasing any, so two calls cannot hand back the same one. */
async function freePorts(count) {
  const { createServer } = await import("node:net");
  const servers = await Promise.all(
    Array.from({ length: count }, () =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server));
      }),
    ),
  );
  const ports = servers.map(server => server.address().port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

test("createDevServerSession becomes ready from server.url when the server never prints a Local: line", async () => {
  const dir = await makeOsTempDir("harness-devserver-nolocal-");
  const [port] = await freePorts(1);
  const serverScript = path.join(dir, "server.mjs");

  // Express, Fastify, Hono and plain http servers all log like this. Before the
  // fix the harness waited 30s for a "Local:" line and then gave up, although
  // the configured server.url had been answering the whole time.
  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
});
server.listen(${port}, "127.0.0.1", () => {
  console.log("[gateway] listening on http://127.0.0.1:${port} (payTo 0.0.1234, 0.001 USDC/KB)");
});
`,
  );

  const startedAt = Date.now();
  const session = await createDevServerSession(
    dir,
    {
      command: `node ${JSON.stringify(serverScript)}`,
      configuredUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 15_000,
    },
    "test",
  );
  try {
    assert.equal(session.url, `http://127.0.0.1:${port}`);
    assert.ok(
      Date.now() - startedAt < 10_000,
      "readiness must come from polling server.url, not from waiting out a URL-detect timeout",
    );
  } finally {
    await session.stop();
  }
});

test("createDevServerSession treats an API whose root answers 404 as up", async () => {
  const dir = await makeOsTempDir("harness-devserver-404-");
  const [port] = await freePorts(1);
  const serverScript = path.join(dir, "server.mjs");

  // Express answers "Cannot GET /" for an unrouted root. The routes the gate
  // walks are what matter, and their status codes are judged there.
  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  res.writeHead(404, { "content-type": "text/html" });
  res.end("Cannot GET " + req.url);
});
server.listen(${port}, "127.0.0.1", () => {
  console.log("Local: http://127.0.0.1:${port}");
});
`,
  );

  const session = await createDevServerSession(
    dir,
    {
      command: `node ${JSON.stringify(serverScript)}`,
      configuredUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 15_000,
    },
    "test",
  );
  try {
    assert.equal(session.url, `http://127.0.0.1:${port}`);
    const health = await fetch(`${session.url}/health`);
    assert.equal(health.status, 200);
  } finally {
    await session.stop();
  }
});

test("createDevServerSession follows the Local: URL when the configured port belongs to someone else", async () => {
  const dir = await makeOsTempDir("harness-devserver-conflict-");
  const { createServer } = await import("node:http");
  const [decoyPort, realPort] = await freePorts(2);

  // A decoy already holds server.url and answers 200 — the situation Next
  // reports as "Port N is in use" before moving. The session must drive the
  // server it started, never the decoy.
  const decoy = createServer((_req, res) => {
    res.writeHead(200);
    res.end("decoy");
  });
  await new Promise(resolve => decoy.listen(decoyPort, "127.0.0.1", resolve));

  const serverScript = path.join(dir, "server.mjs");
  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
console.log("Port ${decoyPort} is in use, using available port ${realPort} instead.");
const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end("real");
});
server.listen(${realPort}, "127.0.0.1", () => {
  console.log("Local: http://127.0.0.1:${realPort}");
});
`,
  );

  try {
    const session = await createDevServerSession(
      dir,
      {
        command: `node ${JSON.stringify(serverScript)}`,
        configuredUrl: `http://127.0.0.1:${decoyPort}`,
        timeoutMs: 15_000,
      },
      "test",
    );
    try {
      assert.equal(session.url, `http://127.0.0.1:${realPort}`);
      assert.equal(await (await fetch(session.url)).text(), "real");
    } finally {
      await session.stop();
    }
  } finally {
    await new Promise(resolve => decoy.close(resolve));
  }
});

test("createDevServerSession never trusts a listener that answered before the server started, whatever it answered", async () => {
  const dir = await makeOsTempDir("harness-devserver-occupied-");
  const { createServer } = await import("node:http");
  const [decoyPort, realPort] = await freePorts(2);

  // A decoy that is unhealthy at first (500) and healthy afterwards. Treating
  // "not ready" as "free" would let the poll adopt it once it turns 200.
  let decoyRequests = 0;
  const decoy = createServer((_req, res) => {
    decoyRequests += 1;
    res.writeHead(decoyRequests === 1 ? 500 : 200);
    res.end("decoy");
  });
  await new Promise(resolve => decoy.listen(decoyPort, "127.0.0.1", resolve));

  const serverScript = path.join(dir, "server.mjs");
  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end("real");
});
setTimeout(() => {
  server.listen(${realPort}, "127.0.0.1", () => {
    console.log("Local: http://127.0.0.1:${realPort}");
  });
}, 1500);
`,
  );

  try {
    const session = await createDevServerSession(
      dir,
      {
        command: `node ${JSON.stringify(serverScript)}`,
        configuredUrl: `http://127.0.0.1:${decoyPort}`,
        timeoutMs: 15_000,
      },
      "test",
    );
    try {
      assert.equal(session.url, `http://127.0.0.1:${realPort}`);
      assert.equal(await (await fetch(session.url)).text(), "real");
    } finally {
      await session.stop();
    }
  } finally {
    await new Promise(resolve => decoy.close(resolve));
  }
});

test("createDevServerSession ignores a port-in-use message about a port that is not server.url", async () => {
  const dir = await makeOsTempDir("harness-devserver-otherport-");
  const [port] = await freePorts(1);
  const serverScript = path.join(dir, "server.mjs");

  // An auxiliary port (a websocket, a proxy) reported as taken must not stop
  // the harness from polling the URL the app does serve.
  await writeFile(
    serverScript,
    `
import { createServer } from "node:http";
console.log("Port 9229 is in use, inspector disabled");
const server = createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok");
});
server.listen(${port}, "127.0.0.1", () => {
  console.log("listening on http://127.0.0.1:${port}");
});
`,
  );

  const session = await createDevServerSession(
    dir,
    {
      command: `node ${JSON.stringify(serverScript)}`,
      configuredUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 15_000,
    },
    "test",
  );
  try {
    assert.equal(session.url, `http://127.0.0.1:${port}`);
  } finally {
    await session.stop();
  }
});
