import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importPlaywright } from "../optionalDeps.js";
import type { WalletCliOptions } from "../types.js";
import { DEFAULT_TESTNET_USDC_TOKEN_ID, REOWN_PROJECT_ID_ENV } from "./constants.js";
import { materializeExtension } from "./extension.js";
import { initPersistentWallet, readOperatorCredentials } from "./funding.js";
import { runWalletPreflight } from "./preflight.js";
import { startWalletRuntime } from "./runtime.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface WalletDemoResult {
  accountId: string;
  transactionId: string;
  status: string;
  dappUrl: string;
  mirrored: boolean;
}

/**
 * Golden path:
 * wallet ready → runtime → extension → harness-pay → Playwright Approve/Sign → mirror check.
 */
export async function runWalletDemo(
  workspacePath: string,
  options: WalletCliOptions,
): Promise<WalletDemoResult> {
  const asset = options.asset ?? "hbar";
  const amount = options.amount ?? 1;
  const headed = options.headed !== false;
  const projectId =
    options.projectId ?? process.env[REOWN_PROJECT_ID_ENV] ?? "harness-demo-project";

  const init = await initPersistentWallet(workspacePath, {
    hbarTarget: options.hbarTarget,
  });
  const preflight = await runWalletPreflight(workspacePath, {
    hbarTarget: options.hbarTarget,
    requireUsdc: asset === "usdc",
    usdcTokenId: DEFAULT_TESTNET_USDC_TOKEN_ID,
    usdcMinimum: amount,
  });
  if (!preflight.ready) {
    throw new Error(preflight.messages.join("\n"));
  }

  const operator = await readOperatorCredentials({});
  const payTo = options.payTo ?? operator.accountId;

  const runtime = await startWalletRuntime({
    wallet: init.wallet,
    projectId,
    preferWalletKit: false,
  });

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "harness-wallet-demo-"));
  const { extensionDir } = await materializeExtension({
    targetDir: tempRoot,
    runtimeBaseUrl: runtime.baseUrl,
    wallet: init.wallet,
    projectId,
  });

  const dapp = await startHarnessPay();
  const dappUrl = new URL(dapp.url);
  dappUrl.searchParams.set("runtime", runtime.baseUrl);
  dappUrl.searchParams.set("payTo", payTo);
  dappUrl.searchParams.set("amount", String(amount));
  dappUrl.searchParams.set("asset", asset);

  const userDataDir = path.join(tempRoot, "chrome-profile");
  await mkdir(userDataDir, { recursive: true });

  const { chromium } = await importPlaywright({ projectRoot: workspacePath });
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !headed,
    // Extensions require a real Chrome channel; Playwright's bundled Chromium
    // rejects --load-extension in recent builds.
    channel: "chrome",
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    const extensionId = await resolveExtensionId(context);
    const page = await context.newPage();
    await page.goto(dappUrl.toString(), { waitUntil: "domcontentloaded" });

    await page.getByRole("button", { name: "Connect Wallet" }).click();

    // Extension list should include Harness Test Wallet (PO1).
    const walletButton = page.getByRole("button", { name: "Harness Test Wallet" });
    await walletButton.waitFor({ timeout: 15_000 });
    if (await walletButton.isVisible()) {
      await walletButton.click({ timeout: 5_000 }).catch(() => undefined);
    }

    const approvePage =
      (await waitForApprovePage(context, 10_000).catch(() => null)) ??
      (await context.newPage());
    if (!approvePage.url().includes("approve.html")) {
      await approvePage.goto(`chrome-extension://${extensionId}/approve.html`);
    }
    await approvePage.getByRole("button", { name: "Approve" }).waitFor({ timeout: 60_000 });
    await approvePage.getByRole("button", { name: "Approve" }).click();

    await page.getByText(/0\.0\.\d+/).first().waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: /Pay 1/ }).click();

    await approvePage.bringToFront();
    await approvePage.getByRole("button", { name: "Sign" }).waitFor({ timeout: 60_000 });
    await approvePage.getByRole("button", { name: "Sign" }).click();

    await page.bringToFront();
    await page.getByText("Payment successful").waitFor({ timeout: 120_000 });
    const resultText = (await page.locator("#result").innerText()).trim();
    const txMatch = resultText.match(/0\.0\.\d+@[\d.]+/);
    if (!txMatch) {
      throw new Error(`Could not parse transaction id from: ${resultText}`);
    }
    const transactionId = txMatch[0];

    const mirrored = await verifyMirrorTransaction(transactionId);
    await mkdir(path.join(workspacePath, ".harness", "wallet"), { recursive: true });
    await writeFile(
      path.join(workspacePath, ".harness", "wallet", "last-demo.json"),
      `${JSON.stringify(
        {
          accountId: init.wallet.accountId,
          transactionId,
          mirrored,
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      accountId: init.wallet.accountId,
      transactionId,
      status: "SUCCESS",
      dappUrl: dappUrl.toString(),
      mirrored,
    };
  } finally {
    await context.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    await dapp.stop().catch(() => undefined);
  }
}

async function resolveExtensionId(
  context: Awaited<ReturnType<Awaited<ReturnType<typeof importPlaywright>>["chromium"]["launchPersistentContext"]>>,
): Promise<string> {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  const url = worker.url();
  const match = url.match(/chrome-extension:\/\/([^/]+)\//);
  if (!match) {
    throw new Error(`Could not parse extension id from service worker url: ${url}`);
  }
  return match[1];
}

async function waitForApprovePage(
  context: Awaited<ReturnType<Awaited<ReturnType<typeof importPlaywright>>["chromium"]["launchPersistentContext"]>>,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = context.pages().find(page => page.url().includes("approve.html"));
    if (match) {
      await match.waitForLoadState("domcontentloaded").catch(() => undefined);
      return match;
    }
    // Extension may open a new page shortly after connect/pay.
    const next = await context.waitForEvent("page", { timeout: 1_000 }).catch(() => null);
    if (next && next.url().includes("approve.html")) {
      await next.waitForLoadState("domcontentloaded").catch(() => undefined);
      return next;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Fallback: open approve.html via extension id is unknown; poll runtime and
  // drive approval through a harness helper page instead.
  throw new Error("Timed out waiting for Harness Test Wallet approve page");
}

async function startHarnessPay(): Promise<{ url: string; stop: () => Promise<void> }> {
  const exampleDir = path.join(PACKAGE_ROOT, "examples", "harness-pay");
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: exampleDir,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await waitForOutput(child, /listening/, 15_000);
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: async () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

async function verifyMirrorTransaction(transactionId: string): Promise<boolean> {
  // Mirror node id: 0.0.x@seconds.nanos -> 0.0.x-seconds-nanos
  const parts = transactionId.split("@");
  if (parts.length !== 2) return false;
  const id = `${parts[0]}-${parts[1].replace(".", "-")}`;
  const url = `https://testnet.mirrornode.hedera.com/api/v1/transactions/${id}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const retry = await fetch(url);
      return retry.ok;
    }
    return true;
  } catch {
    return false;
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not allocate port"));
          return;
        }
        const { port } = address;
        server.close(error => {
          if (error) reject(error);
          else resolve(port);
        });
      });
      server.on("error", reject);
    }, reject);
  });
}

function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      reject(new Error(`Timed out starting child process. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", code => {
      clearTimeout(timer);
      reject(new Error(`Child exited early with code ${code}. Output:\n${output}`));
    });
  });
}
