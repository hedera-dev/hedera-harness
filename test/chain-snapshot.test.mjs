import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { takeChainSnapshot, revertChainSnapshot } = await import(
  pathToFileURL(path.resolve("dist/validation/chainSnapshot.js")).href
);

/** A JSON-RPC node that records what it was asked and answers from `replies`. */
async function fakeNode(replies) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params });
      const reply = replies[method];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, calls, close: () => new Promise(resolve => server.close(resolve)) };
}

const localConfig = url => ({
  enabled: true,
  network: "local",
  operator: { accountIdEnv: "HEDERA_OPERATOR_ID", privateKeyEnv: "HEDERA_OPERATOR_KEY" },
  local: { rpcUrl: url, grpcUrl: "localhost:50211", mirrorUrl: "http://localhost:5551" },
  fundingHbar: 10,
  sweepBack: true,
  expose: { browserLocalStorageKey: "burnerWallet.pk", envVars: [] },
});

test("snapshot and revert speak evm_snapshot and evm_revert", async () => {
  const node = await fakeNode({ evm_snapshot: { result: "0x1" }, evm_revert: { result: true } });
  try {
    const config = localConfig(node.url);
    const id = await takeChainSnapshot(config);
    assert.equal(id, "0x1");
    assert.equal(await revertChainSnapshot(config, id), true);
    assert.deepEqual(
      node.calls.map(c => c.method),
      ["evm_snapshot", "evm_revert"],
    );
    assert.deepEqual(node.calls[1].params, ["0x1"]);
  } finally {
    await node.close();
  }
});

test("testnet takes no snapshot and reverts nothing", async () => {
  const node = await fakeNode({ evm_snapshot: { result: "0x1" } });
  try {
    const config = { ...localConfig(node.url), network: "testnet" };
    assert.equal(await takeChainSnapshot(config), undefined);
    assert.equal(await revertChainSnapshot(config, "0x1"), false);
    assert.deepEqual(node.calls, [], "testnet must not reach a node");
  } finally {
    await node.close();
  }
});

test("a node without evm_snapshot yields no id rather than throwing the run away", async () => {
  const node = await fakeNode({
    evm_snapshot: { error: { code: -32601, message: "Method not found" } },
  });
  try {
    await assert.rejects(() => takeChainSnapshot(localConfig(node.url)), /Method not found/);
  } finally {
    await node.close();
  }
});

test("a refused revert reports false", async () => {
  const node = await fakeNode({ evm_revert: { result: false } });
  try {
    assert.equal(await revertChainSnapshot(localConfig(node.url), "0xdead"), false);
  } finally {
    await node.close();
  }
});
