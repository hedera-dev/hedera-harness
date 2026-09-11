import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppWorkspace } from "./appWorkspace.js";
import { inspectNextAssetHealth, nextAssetHealthHint } from "./nextAssetHealth.js";
import type { WalletSessionAction } from "./types.js";
import { detectLiveAppUrl, waitForDappReady } from "./walletE2e.js";
import {
  closeExtraMetaMaskPages,
  launchPreparedWalletBrowser,
  METAMASK_HANDSHAKE_TIMEOUT_MS,
  releaseChromeProfile,
  type DappwrightWallet,
} from "./walletMetaMask.js";
import { chromeProfilePath, inspectWalletReady } from "./walletVault.js";

const STATE_REL = [".harness", "wallet-session.json"] as const;
export const DEFAULT_SESSION_PORT = 17374;
export const START_TIMEOUT_MS = 180_000;
export const BROWSER_HANDSHAKE_HUNG_MS = METAMASK_HANDSHAKE_TIMEOUT_MS;
const ARIA_MAX = 20_000;
const HARNESS_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

export interface WalletSessionParams {
  url?: string;
  port?: number;
  ref?: string;
  testId?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  mmAction?: string;
  key?: string;
}

export type WalletSessionPhase = "launching" | "browser" | "up";

export interface WalletSessionState {
  pid: number;
  port: number;
  url: string;
  workspace: string;
  phase: WalletSessionPhase;
  startedAt?: number;
  phaseAt?: number;
}

type DappPage = {
  url: () => string;
  goto: (url: string, options?: { waitUntil?: "load"; timeout?: number }) => Promise<unknown>;
  reload?: (options?: { waitUntil?: "load"; timeout?: number }) => Promise<unknown>;
  waitForLoadState?: (state: "load" | "networkidle", options?: { timeout?: number }) => Promise<void>;
  content: () => Promise<string>;
  keyboard?: { press: (key: string) => Promise<void> };
  locator: (selector: string) => SessionLocator;
  getByTestId: (id: string) => SessionLocator;
  getByRole: (role: string, options?: { name?: string | RegExp }) => SessionLocator;
  getByText: (text: string | RegExp) => SessionLocator;
  getByPlaceholder?: (text: string | RegExp) => SessionLocator;
  ariaSnapshot?: (options?: { mode?: "ai" | "default"; timeout?: number }) => Promise<string>;
  evaluate: (fn: (...args: never[]) => unknown, arg?: unknown) => Promise<unknown>;
};

type SessionLocator = {
  first: () => SessionLocator;
  click: (options?: { timeout?: number }) => Promise<void>;
  fill: (value: string, options?: { timeout?: number }) => Promise<void>;
  isVisible: (options?: { timeout?: number }) => Promise<boolean>;
};

interface SessionRuntime {
  context: {
    close: () => Promise<unknown>;
    pages: () => unknown[];
    addInitScript?: (fn: () => void) => Promise<unknown>;
    newPage: () => Promise<unknown>;
  };
  wallet: DappwrightWallet;
  page: DappPage;
}

let runtime: SessionRuntime | undefined;
let serveWorkspace = "";

export function sessionStatePath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...STATE_REL);
}

export function readSessionState(workspaceDir: string): WalletSessionState | undefined {
  const file = sessionStatePath(workspaceDir);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WalletSessionState>;
    if (typeof raw.pid !== "number" || typeof raw.port !== "number") return undefined;
    const phase: WalletSessionPhase =
      raw.phase === "up" ? "up" : raw.phase === "browser" ? "browser" : "launching";
    return {
      pid: raw.pid,
      port: raw.port,
      url: String(raw.url || ""),
      workspace: String(raw.workspace || workspaceDir),
      phase,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : undefined,
      phaseAt: typeof raw.phaseAt === "number" ? raw.phaseAt : undefined,
    };
  } catch {
    return undefined;
  }
}

export function formatSessionReport(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

export function sessionShouldReuse(livePhase: string | undefined): boolean {
  return livePhase === "up";
}

export function sessionPhaseIsHung(state: WalletSessionState, now = Date.now()): boolean {
  if (state.phase === "up") return false;
  const at = state.phaseAt ?? state.startedAt ?? 0;
  if (!at) return false;
  const limit = state.phase === "browser" ? BROWSER_HANDSHAKE_HUNG_MS : START_TIMEOUT_MS;
  return now - at >= limit;
}

export function formatHungSessionReport(state: Pick<WalletSessionState, "pid" | "port" | "phase">): string {
  return formatSessionReport([
    "session=hung",
    `pid=${state.pid}`,
    `port=${state.port}`,
    `phase=${state.phase}`,
    "reason=Chromium was up but dappwright never finished (locked chrome-profile or leftover chrome on :17374).",
    "repair=session torn down; call start again or harness_wallet_e2e",
    "do_not_sleep=true",
  ]);
}

export async function runWalletSession(
  workspaceDir: string,
  action: WalletSessionAction,
  params: WalletSessionParams = {},
): Promise<string> {
  const workspace = resolveAppWorkspace(workspaceDir);
  if (action === "serve") return runSessionServe(workspace, params);
  if (action === "start") return startSession(workspace, params);
  if (action === "stop") return stopSession(workspace);
  if (action === "status") return statusSession(workspace);
  return callSession(workspace, action, params);
}

async function startSession(workspace: string, params: WalletSessionParams): Promise<string> {
  const ready = inspectWalletReady(workspace);
  if (!ready.ready) {
    return formatSessionReport([
      "session=down",
      `reason=${ready.reason}`,
      ready.provisionCommand,
    ]);
  }

  const existing = readSessionState(workspace);
  if (existing && isPidAlive(existing.pid) && (await sessionHttpOk(existing.port))) {
    const live = await httpJson(existing.port, "GET", "/status").catch(() => ({ phase: existing.phase }));
    const livePhase = String(live.phase || existing.phase);
    if (sessionShouldReuse(livePhase)) {
      const status = await callSession(workspace, "status", params);
      const want = params.url?.trim();
      if (want) {
        await callSession(workspace, "goto", { url: want });
        return `${status}\nreused=true\ncleaned=false\ngoto=${want}`;
      }
      return `${status}\nreused=true\ncleaned=false`;
    }
  }

  // Stop first (no-op if nothing is up). Leftover launching/browser/chrome-profile
  // processes are why Windows hangs for two attempts — do not wait on them.
  teardownSession(workspace, existing);
  await delay(800);
  const appUrl = await detectLiveAppUrl(params.url);
  const listenPort = params.port && params.port > 0 ? params.port : DEFAULT_SESSION_PORT;
  const child = spawn(
    nodeBin(),
    [
      HARNESS_ENTRY,
      "wallet",
      "session",
      "serve",
      "--workspace",
      workspace,
      "--url",
      appUrl,
      "--port",
      String(listenPort),
    ],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      cwd: path.dirname(HARNESS_ENTRY),
    },
  );
  const pid = child.pid ?? 0;
  child.unref();
  if (!pid) return formatSessionReport(["session=down", "reason=failed to spawn session process"]);

  const waited = await waitUntilUp(workspace, pid, Date.now() + START_TIMEOUT_MS);
  const state = readSessionState(workspace) ?? {
    pid,
    port: listenPort,
    url: appUrl,
    workspace,
    phase: "launching" as const,
  };
  if (waited === "up") return formatUpReport(state, { reused: false, cleaned: true });
  teardownSession(workspace, state);
  return formatHungSessionReport(state);
}

function formatUpReport(
  state: WalletSessionState,
  flags: { reused: boolean; cleaned: boolean },
): string {
  return formatSessionReport([
    "session=up",
    `pid=${state.pid}`,
    `port=${state.port}`,
    `url=${state.url}`,
    "wallet=metamask-extension",
    `reused=${flags.reused}`,
    `cleaned=${flags.cleaned}`,
    "dom=use harness_wallet_dom snapshot — not Playwright MCP vanilla Chrome",
    "mm=use harness_wallet_mm approve|confirm",
  ]);
}

async function waitUntilUp(
  workspace: string,
  pid: number,
  deadline: number,
): Promise<"up" | "dead" | "timeout" | "hung"> {
  while (Date.now() < deadline) {
    const state = readSessionState(workspace);
    if (state && sessionPhaseIsHung(state)) return "hung";
    if (state && (await sessionHttpOk(state.port))) {
      const body = await httpJson(state.port, "GET", "/status").catch(() => ({ phase: state.phase }));
      if (String(body.phase || "") === "up") return "up";
    }
    const httpAlive = state ? await sessionHttpOk(state.port) : false;
    if (!isPidAlive(pid) && !httpAlive) return "dead";
    await delay(800);
  }
  return "timeout";
}

function teardownSession(workspace: string, state?: WalletSessionState): void {
  if (state) {
    void httpJson(state.port, "POST", "/stop").catch(() => undefined);
    stopSessionProcess(state);
  }
  releaseChromeProfile(chromeProfilePath(workspace));
  clearSessionState(workspace);
}

function stopSession(workspace: string): string {
  const state = readSessionState(workspace);
  teardownSession(workspace, state);
  return formatSessionReport(["session=down", "action=stop", state ? `killed=${state.pid}` : ""]);
}

async function statusSession(workspace: string): Promise<string> {
  const state = readSessionState(workspace);
  if (!state || !isPidAlive(state.pid)) {
    return formatSessionReport(["session=down", "action=status"]);
  }
  const live = (await sessionHttpOk(state.port))
    ? await httpJson(state.port, "GET", "/status").catch(() => ({ phase: state.phase }))
    : { phase: state.phase };
  const phase = String(live.phase || state.phase);
  const merged: WalletSessionState = {
    ...state,
    phase: phase === "up" ? "up" : phase === "browser" ? "browser" : "launching",
  };
  if (sessionPhaseIsHung(merged)) {
    return formatSessionReport([
      "session=hung",
      `pid=${state.pid}`,
      `port=${state.port}`,
      `phase=${merged.phase}`,
      "reason=Handshake still not up. Call start again (it tears down leftover Chromium) or harness_wallet_e2e.",
      "do_not_sleep=true",
    ]);
  }
  return formatSessionReport([
    `session=${phase}`,
    `pid=${state.pid}`,
    `port=${state.port}`,
    `url=${state.url || "none"}`,
    "wallet=metamask-extension",
    phase === "launching" || phase === "browser"
      ? "wait=call start again — it waits or recycles; do not bash Start-Sleep / netstat"
      : "",
  ]);
}

async function callSession(
  workspace: string,
  action: WalletSessionAction,
  params: WalletSessionParams,
): Promise<string> {
  const state = readSessionState(workspace);
  if (!state || !isPidAlive(state.pid)) {
    return formatSessionReport(["session=down", "reason=Start harness_wallet_session first."]);
  }
  const pathName =
    action === "mm" ? "/mm" : action === "press" ? "/press" : `/${action}`;
  const body = await httpJson(state.port, action === "snapshot" || action === "status" ? "GET" : "POST", pathName, {
    url: params.url,
    ref: params.ref,
    testId: params.testId,
    role: params.role,
    name: params.name,
    text: params.text,
    value: params.value,
    action: params.mmAction || (action === "mm" ? "approve" : undefined),
    key: params.key,
  });
  if (typeof body.text === "string") return body.text;
  return formatSessionReport(Object.entries(body).map(([key, value]) => `${key}=${String(value)}`));
}

async function runSessionServe(workspace: string, params: WalletSessionParams): Promise<string> {
  const ready = inspectWalletReady(workspace);
  if (!ready.ready) {
    throw new Error(`${ready.reason}\n${ready.provisionCommand}`);
  }

  serveWorkspace = workspace;
  const appUrl = await detectLiveAppUrl(params.url);
  const listenPort = params.port && params.port > 0 ? params.port : DEFAULT_SESSION_PORT;
  const startedAt = Date.now();

  await new Promise<void>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleSessionHttp(req, res);
    });
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Wallet session failed to bind 127.0.0.1."));
        return;
      }
      writeSessionState(workspace, {
        pid: process.pid,
        port: address.port,
        url: appUrl,
        workspace,
        phase: "launching",
        startedAt,
        phaseAt: startedAt,
      });
      resolve();
    });
  });

  try {
    const prepared = await launchPreparedWalletBrowser(workspace, {
      onChromiumReady: () => {
        const state = readSessionState(workspace);
        if (state) {
          writeSessionState(workspace, { ...state, phase: "browser", phaseAt: Date.now() });
        }
      },
    });
    const ctx = prepared.context as SessionRuntime["context"];
    await ctx.addInitScript?.(clearDappWalletStorage);
    const page = (await ctx.newPage()) as DappPage;
    await page.goto(appUrl, { waitUntil: "load", timeout: 45_000 });
    let dappReady = await waitForDappReady(page as never);
    if (!dappReady.css || !dappReady.js) {
      await page.reload?.({ waitUntil: "load", timeout: 45_000 }).catch(() => undefined);
      dappReady = await waitForDappReady(page as never);
    }
    await closeExtraMetaMaskPages(ctx, prepared.wallet.page);
    runtime = { context: ctx, wallet: prepared.wallet, page };
    const state = readSessionState(workspace);
    if (state) {
      writeSessionState(workspace, {
        ...state,
        url: page.url(),
        phase: "up",
        phaseAt: Date.now(),
      });
    }
    if (!dappReady.css || !dappReady.js) {
      const health = await inspectNextAssetHealth(appUrl);
      console.log(nextAssetHealthHint(health) || "Dapp HTML loaded without Next.js CSS/JS.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    await shutdownRuntime();
    releaseChromeProfile(chromeProfilePath(workspace));
    clearSessionState(workspace);
    process.exit(1);
  }

  await new Promise<void>(resolve => {
    const stop = () => {
      void shutdownRuntime().finally(() => {
        releaseChromeProfile(chromeProfilePath(workspace));
        clearSessionState(workspace);
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return formatSessionReport(["session=down"]);
}

async function handleSessionHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/status") {
      json(res, 200, await statusPayload());
      return;
    }
    if (req.method === "GET" && url.pathname === "/snapshot") {
      json(res, 200, { text: await snapshotText() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      json(res, 200, { text: "session=stopping" });
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
      return;
    }
    if (req.method !== "POST") {
      json(res, 404, { error: "not-found" });
      return;
    }
    const body = await readJsonBody(req);
    if (url.pathname === "/goto") {
      json(res, 200, { text: await gotoDapp(String(body.url || "")) });
      return;
    }
    if (url.pathname === "/click") {
      json(res, 200, { text: await clickDapp(body) });
      return;
    }
    if (url.pathname === "/fill") {
      json(res, 200, { text: await fillDapp(body) });
      return;
    }
    if (url.pathname === "/press") {
      json(res, 200, { text: await pressDapp(String(body.key || "Escape")) });
      return;
    }
    if (url.pathname === "/mm") {
      json(res, 200, { text: await mmAction(String(body.action || "approve")) });
      return;
    }
    json(res, 404, { error: "not-found" });
  } catch (error) {
    json(res, 500, { text: `error=${error instanceof Error ? error.message : String(error)}` });
  }
}

async function statusPayload(): Promise<Record<string, string>> {
  const state = serveWorkspace ? readSessionState(serveWorkspace) : undefined;
  const phase = runtime ? "up" : state?.phase === "browser" ? "browser" : "launching";
  return {
    session: phase,
    phase,
    url: runtime?.page.url() ?? "",
    wallet: "metamask-extension",
  };
}

async function snapshotText(): Promise<string> {
  if (!runtime) {
    const state = serveWorkspace ? readSessionState(serveWorkspace) : undefined;
    if (state?.phase === "browser") {
      return formatSessionReport([
        "session=browser",
        "reason=Chromium is up; MetaMask handshake still running.",
        "wait=call harness_wallet_session start — it waits or recycles. Do not bash Start-Sleep.",
      ]);
    }
    return "session=launching\nreason=MetaMask Chromium is still starting.";
  }
  const page = runtime.page;
  const fields = await readFields(page);
  let aria = "";
  try {
    aria = (await page.ariaSnapshot?.({ mode: "ai", timeout: 8_000 })) ?? "";
  } catch {
    aria = "";
  }
  if (aria.length > ARIA_MAX) aria = `${aria.slice(0, ARIA_MAX)}\n…truncated`;
  return formatSessionReport([
    "session=up",
    `url=${page.url()}`,
    "wallet=metamask-extension",
    "quote_input_values_from_this_snapshot=true",
    "never_invent_amount=true",
    fields.length ? "inputs:" : "inputs=none",
    ...fields.map(
      field =>
        `- testid=${field.testid || "none"} type=${field.type} value=${field.value || '""'} label=${field.label || "none"}`,
    ),
    "aria:",
    aria || "(aria snapshot unavailable — use inputs= and testid/name)",
  ]);
}

async function gotoDapp(target: string): Promise<string> {
  if (!runtime) return "session=launching";
  const url = target.trim() || runtime.page.url();
  await runtime.page.goto(url, { waitUntil: "load", timeout: 45_000 });
  const ready = await waitForDappReady(runtime.page as never);
  return formatSessionReport([
    `goto=${runtime.page.url()}`,
    `css=${ready.css}`,
    `js=${ready.js}`,
    await snapshotText(),
  ]);
}

async function clickDapp(target: Record<string, unknown>): Promise<string> {
  if (!runtime) return "session=launching";
  const clicked = await clickTarget(runtime.page, target);
  return formatSessionReport([
    `click=${clicked ? "ok" : "miss"}`,
    `url=${runtime.page.url()}`,
  ]);
}

async function fillDapp(target: Record<string, unknown>): Promise<string> {
  if (!runtime) return "session=launching";
  const value = String(target.value ?? "");
  if (!value) return "fill=miss\nreason=value is required";
  const filled = await fillTarget(runtime.page, target, value);
  const testId = String(target.testId || target.testid || "");
  if (testId) await forceInputValue(runtime.page, testId, value);
  const fields = await readFields(runtime.page);
  const live = testId ? fields.find(field => field.testid === testId)?.value : "";
  return formatSessionReport([
    `fill=${filled ? "ok" : "miss"}`,
    `value_sent=${value}`,
    `value_live=${live || "unknown"}`,
    live && live !== value ? "mismatch=input-did-not-keep-value" : "",
    await snapshotText(),
  ]);
}

async function pressDapp(key: string): Promise<string> {
  if (!runtime) return "session=launching";
  try {
    await runtime.page.keyboard?.press(key);
    return `press=${key}`;
  } catch {
    return `press=miss\nkey=${key}`;
  }
}

async function mmAction(raw: string): Promise<string> {
  if (!runtime) return "session=launching";
  const action = raw === "confirm" || raw === "confirmTransaction" ? "confirmTransaction" : "approve";
  const ok = await firstTrue([
    (async () => {
      try {
        await runtime!.wallet[action]();
        return true;
      } catch {
        return false;
      }
    })(),
    clickExtensionDialog(runtime.context, action === "approve" ? "connect" : "confirm"),
  ]);
  return formatSessionReport([
    `metamask_${action === "approve" ? "connect" : "sign"}=${ok ? (action === "approve" ? "approved" : "confirmed") : "no-popup-or-failed"}`,
  ]);
}

async function clickTarget(page: DappPage, target: Record<string, unknown>): Promise<boolean> {
  const ref = String(target.ref || "");
  const testId = String(target.testId || target.testid || "");
  const role = String(target.role || "button");
  const name = String(target.name || "");
  const text = String(target.text || "");
  const tries: Array<() => Promise<boolean>> = [];
  if (ref) {
    tries.push(async () => {
      await page.locator(`aria-ref=${ref}`).first().click({ timeout: 5_000 });
      return true;
    });
  }
  if (testId) {
    tries.push(async () => {
      await page.getByTestId(testId).first().click({ timeout: 5_000 });
      return true;
    });
  }
  if (name) {
    tries.push(async () => {
      await page.getByRole(role, { name: new RegExp(escapeRegExp(name), "i") }).first().click({ timeout: 5_000 });
      return true;
    });
  }
  if (text) {
    tries.push(async () => {
      await page.getByText(new RegExp(escapeRegExp(text), "i")).first().click({ timeout: 5_000 });
      return true;
    });
  }
  for (const tryClick of tries) {
    try {
      if (await tryClick()) return true;
    } catch {
      // next locator
    }
  }
  return false;
}

async function fillTarget(page: DappPage, target: Record<string, unknown>, value: string): Promise<boolean> {
  const ref = String(target.ref || "");
  const testId = String(target.testId || target.testid || "");
  const role = String(target.role || "textbox");
  const name = String(target.name || "");
  const tries: Array<() => Promise<boolean>> = [];
  if (ref) {
    tries.push(async () => {
      const loc = page.locator(`aria-ref=${ref}`).first();
      await loc.fill("", { timeout: 5_000 }).catch(() => undefined);
      await loc.fill(value, { timeout: 5_000 });
      return true;
    });
  }
  if (testId) {
    tries.push(async () => {
      const loc = page.getByTestId(testId).first();
      await loc.fill("", { timeout: 5_000 }).catch(() => undefined);
      await loc.fill(value, { timeout: 5_000 });
      return true;
    });
  }
  if (name) {
    tries.push(async () => {
      const loc = page.getByRole(role, { name: new RegExp(escapeRegExp(name), "i") }).first();
      await loc.fill("", { timeout: 5_000 }).catch(() => undefined);
      await loc.fill(value, { timeout: 5_000 });
      return true;
    });
  }
  for (const tryFill of tries) {
    try {
      if (await tryFill()) return true;
    } catch {
      // next
    }
  }
  return false;
}

async function readFields(page: DappPage): Promise<Array<{ testid: string; type: string; value: string; label: string }>> {
  try {
    const raw = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("input, textarea, select")];
      return nodes.map(node => {
        const el = node as HTMLInputElement;
        const id = el.getAttribute("data-testid") || "";
        const type = (el.type || el.tagName).toLowerCase();
        const label =
          (el.labels && el.labels[0]?.innerText) ||
          el.getAttribute("aria-label") ||
          el.getAttribute("placeholder") ||
          "";
        const value = type === "password" ? "[hidden]" : el.value || "";
        return { testid: id, type, value, label: label.trim().slice(0, 80) };
      });
    });
    return Array.isArray(raw) ? (raw as Array<{ testid: string; type: string; value: string; label: string }>) : [];
  } catch {
    return [];
  }
}

async function forceInputValue(page: DappPage, testId: string, value: string): Promise<void> {
  try {
    await page.evaluate(
      (({ id, next }: { id: string; next: string }) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc?.set?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }) as never,
      { id: testId, next: value } as never,
    );
  } catch {
    // locator fill already tried
  }
}

async function clickExtensionDialog(
  context: { pages: () => unknown[] },
  kind: "connect" | "confirm",
): Promise<boolean> {
  const names = kind === "connect" ? [/connect/i, /next/i] : [/confirm/i, /sign/i];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const raw of context.pages()) {
      const page = raw as DappPage;
      let href = "";
      try {
        href = page.url();
      } catch {
        continue;
      }
      if (!href.startsWith("chrome-extension://")) continue;
      for (const name of names) {
        try {
          await page.getByRole("button", { name }).first().click({ timeout: 800 });
          return true;
        } catch {
          // next
        }
      }
    }
    await delay(400);
  }
  return false;
}

async function firstTrue(tasks: Array<Promise<boolean>>): Promise<boolean> {
  return await new Promise(resolve => {
    let pending = tasks.length;
    if (!pending) {
      resolve(false);
      return;
    }
    for (const task of tasks) {
      void Promise.resolve(task)
        .then(ok => {
          if (ok) resolve(true);
          else {
            pending -= 1;
            if (!pending) resolve(false);
          }
        })
        .catch(() => {
          pending -= 1;
          if (!pending) resolve(false);
        });
    }
  });
}

function clearDappWalletStorage(): void {
  const g = globalThis as {
    location?: { hostname: string; protocol?: string };
    localStorage?: { clear: () => void };
    sessionStorage?: { clear: () => void };
  };
  if (g.location?.protocol === "chrome-extension:") return;
  const host = g.location?.hostname ?? "";
  if (host !== "localhost" && host !== "127.0.0.1") return;
  try {
    g.localStorage?.clear();
    g.sessionStorage?.clear();
  } catch {
    // ignore
  }
}

async function shutdownRuntime(): Promise<void> {
  const current = runtime;
  runtime = undefined;
  await current?.context.close().catch(() => undefined);
}

function writeSessionState(workspace: string, state: WalletSessionState): void {
  const file = sessionStatePath(workspace);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function clearSessionState(workspace: string): void {
  try {
    rmSync(sessionStatePath(workspace), { force: true });
  } catch {
    // ignore
  }
}

function stopSessionProcess(state: WalletSessionState): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(state.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(state.pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sessionHttpOk(port: number): Promise<boolean> {
  return httpJson(port, "GET", "/status")
    .then(() => true)
    .catch(() => false);
}

function httpJson(
  port: number,
  method: string,
  pathname: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = method === "GET" ? undefined : JSON.stringify(body ?? {});
    const req = createHttpRequest(port, method, pathname, payload, (status, raw) => {
      try {
        const parsed = JSON.parse(raw || "{}") as Record<string, unknown>;
        if (status >= 400 && !parsed.text) reject(new Error(String(parsed.error || raw || status)));
        else resolve(parsed);
      } catch {
        resolve({ text: raw });
      }
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("session http timeout"));
    });
    req.end(payload);
  });
}

function createHttpRequest(
  port: number,
  method: string,
  pathname: string,
  payload: string | undefined,
  onEnd: (status: number, raw: string) => void,
) {
  const req = httpRequest(
    {
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
      timeout: 30_000,
      headers: payload
        ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
        : undefined,
    },
    res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk as Buffer));
      res.on("end", () => onEnd(res.statusCode ?? 500, Buffer.concat(chunks).toString("utf8")));
    },
  );
  return req;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body)}\n`);
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nodeBin(): string {
  const exe = String(process.execPath || "").replace(/\\/g, "/");
  if (/node(?:\.exe)?$/i.test(exe)) return process.execPath;
  return "node";
}
