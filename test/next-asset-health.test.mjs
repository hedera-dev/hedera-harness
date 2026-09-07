import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const health = await import(pathToFileURL(path.resolve("dist/nextAssetHealth.js")).href);

function listen(handler) {
  const server = createServer(handler);
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test("inspectNextAssetHealth is ok when the page has no _next assets", async () => {
  const { server, url } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>ok</html>");
  });
  try {
    const result = await health.inspectNextAssetHealth(url);
    assert.equal(result.htmlOk, true);
    assert.equal(result.cssOk, true);
    assert.equal(result.jsOk, true);
    assert.equal(result.hasNextAssets, false);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});

test("inspectNextAssetHealth fails when Next CSS 404s", async () => {
  const { server, url } = await listen((req, res) => {
    if (String(req.url).includes("layout.css") || String(req.url).includes("main-app.js")) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<link rel="stylesheet" href="/_next/static/css/app/layout.css"/><script src="/_next/static/chunks/main-app.js"></script>',
    );
  });
  try {
    const result = await health.inspectNextAssetHealth(url);
    assert.equal(result.htmlOk, true);
    assert.equal(result.cssOk, false);
    assert.equal(result.jsOk, false);
    assert.match(health.nextAssetHealthHint(result), /layout\.css/);
    assert.match(health.nextAssetHealthHint(result), /next:dev/);
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});

test("inspectNextAssetHealth passes when Next CSS and JS 200", async () => {
  const { server, url } = await listen((req, res) => {
    const pathName = String(req.url).split("?")[0];
    if (pathName.endsWith(".css") || pathName.endsWith(".js")) {
      res.writeHead(200, { "content-type": pathName.endsWith(".css") ? "text/css" : "text/javascript" });
      res.end("/* ok */");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<link rel="stylesheet" href="/_next/static/css/app/layout.css"/><script src="/_next/static/chunks/main-app.js"></script>',
    );
  });
  try {
    const result = await health.inspectNextAssetHealth(url);
    assert.equal(result.cssOk, true);
    assert.equal(result.jsOk, true);
    assert.equal(health.nextAssetHealthHint(result), "");
  } finally {
    await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
  }
});
