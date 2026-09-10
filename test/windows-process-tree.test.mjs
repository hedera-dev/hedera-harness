import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { waitForDeath } from "./processProbe.mjs";
import { makeOsTempDir } from "./tmpDir.mjs";

const { executeCommand } = await import(pathToFileURL(path.resolve("dist/command.js")).href);

/**
 * Windows has no process group to signal, so the timeout has to walk the PID
 * tree instead. `child.kill()` reaches cmd.exe and stops there, which is how a
 * real run leaves yarn and next-server holding the port after the harness has
 * already reported a timeout and moved on. The shape below is that run in
 * miniature: cmd.exe -> node -> node, every layer asserted dead.
 */
test(
  "a timeout sweeps the whole Windows process tree, not just cmd.exe",
  { skip: process.platform === "win32" ? false : "Windows-only teardown path" },
  async () => {
    const dir = await makeOsTempDir("harness-wintree-");
    const pidsFile = path.join(dir, "pids.json");
    const grandchildPidFile = path.join(dir, "grandchild.pid");
    const grandchild = path.join(dir, "grandchild.mjs");
    const parent = path.join(dir, "parent.mjs");

    await writeFile(
      grandchild,
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid));
setInterval(() => {}, 1_000);
`,
    );

    // process.ppid is the cmd.exe the shell option spawned — the only pid the
    // harness itself ever sees, and the only one child.kill() would have hit.
    await writeFile(
      parent,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore" });
writeFileSync(
  ${JSON.stringify(pidsFile)},
  JSON.stringify({ shell: process.ppid, parent: process.pid }),
);
setInterval(() => {}, 1_000);
`,
    );

    const result = await executeCommand({
      command: `node ${JSON.stringify(parent)}`,
      cwd: dir,
      shell: true,
      timeoutMs: 1_500,
    });

    assert.equal(result.timedOut, true, "should report a timeout");

    const { shell, parent: parentPid } = JSON.parse(await readFile(pidsFile, "utf8"));
    const grandchildPid = Number.parseInt((await readFile(grandchildPidFile, "utf8")).trim(), 10);

    assert.ok(await waitForDeath(grandchildPid), `grandchild ${grandchildPid} should be gone`);
    assert.ok(await waitForDeath(parentPid), `child ${parentPid} should be gone`);
    assert.ok(await waitForDeath(shell), `shell ${shell} should be gone`);
  },
);
