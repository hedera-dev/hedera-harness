import { request as httpRequest } from "node:http";
import { inspectNextAssetHealth, nextAssetHealthHint } from "./nextAssetHealth.js";
import { inspectWalletReady } from "./walletVault.js";
import {
  closeExtraMetaMaskPages,
  launchPreparedWalletBrowser,
  type DappwrightWallet,
} from "./walletMetaMask.js";

const DEFAULT_APP_URL = "http://127.0.0.1:3000";
const LIVE_PORTS = [3000, 3003, 3001, 3002, 5173, 4173];
const HASHSCAN_RE = /hashscan\.io\/[^\s"'<>]+/i;

interface PageLike {
  goto: (
    url: string,
    options?: { waitUntil?: "domcontentloaded" | "load" | "networkidle"; timeout?: number },
  ) => Promise<unknown>;
  url: () => string;
  content: () => Promise<string>;
  reload?: (options?: { waitUntil?: "load"; timeout?: number }) => Promise<unknown>;
  waitForLoadState?: (state: "load" | "networkidle", options?: { timeout?: number }) => Promise<void>;
  evaluate: {
    (fn: () => unknown | Promise<unknown>): Promise<unknown>;
    <T>(fn: (arg: T) => unknown | Promise<unknown>, arg: T): Promise<unknown>;
  };
  getByRole: (role: "button" | "link", options?: { name?: RegExp }) => LocatorLike;
  getByText: (text: RegExp) => LocatorLike;
  getByTestId?: (testId: string) => LocatorLike;
  getByPlaceholder?: (text: string | RegExp) => LocatorLike;
  keyboard?: { press: (key: string) => Promise<void> };
}

interface LocatorLike {
  first: () => LocatorLike;
  isVisible: (options?: { timeout?: number }) => Promise<boolean>;
  click: (options?: { timeout?: number }) => Promise<void>;
  fill?: (value: string, options?: { timeout?: number }) => Promise<void>;
  inputValue?: (options?: { timeout?: number }) => Promise<string>;
}

export const DEFAULT_SEND_AMOUNT_HBAR = "0.01";

/**
 * Drive the vault MetaMask (dappwright Chromium) against the live app.
 * Playwright MCP vanilla Chrome is not this path — that one has no extension.
 * Never prints private keys or raw 0x blobs (plugin would redact them anyway).
 */
export async function runWalletE2e(
  workspaceDir: string,
  appUrl?: string,
  send?: { amount?: string; to?: string },
): Promise<string> {
  const ready = inspectWalletReady(workspaceDir);
  if (!ready.ready) {
    return [`metamask_e2e=fail`, `reason=${ready.reason}`, ready.provisionCommand].join("\n");
  }

  const url = await detectLiveAppUrl(appUrl);
  const prepared = await launchPreparedWalletBrowser(workspaceDir);
  const lines = [
    "metamask_e2e=running",
    `url=${url}`,
    "wallet=metamask-extension",
    `profile=${prepared.profile}`,
    "burner_is_not_success=true",
  ];
  try {
    const ctx = prepared.context as typeof prepared.context & {
      addInitScript?: (fn: () => void) => Promise<unknown>;
    };
    await ctx.addInitScript?.(clearDappWalletStorage);
    // pages()[0] is almost always the MetaMask extension UI. Navigating that tab
    // to the dapp yields SSR HTML without _next CSS/JS (unstyled Connect that
    // does not work). Always use a real browser tab.
    const page = (await ctx.newPage()) as PageLike;
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    const dappReady = await waitForDappReady(page);
    lines.push(`loaded=${page.url()}`, `css=${dappReady.css}`, `js=${dappReady.js}`);
    if (!dappReady.css || !dappReady.js) {
      await page.reload?.({ waitUntil: "load", timeout: 45_000 }).catch(() => undefined);
      const again = await waitForDappReady(page);
      lines.push(`reload_css=${again.css}`, `reload_js=${again.js}`);
      if (!again.css || !again.js) {
        const health = await inspectNextAssetHealth(url);
        lines.push(
          "metamask_e2e=fail",
          `reason=${nextAssetHealthHint(health) || "Dapp HTML loaded without Next.js CSS/JS."}`,
        );
        return lines.join("\n");
      }
    }

    const staleTabs = await closeExtraMetaMaskPages(ctx, prepared.wallet.page);
    lines.push(`stale_mm_tabs_closed=${staleTabs}`);

    const connectVisible = await visible(page.getByRole("button", { name: /connect wallet/i }));
    if (!connectVisible) {
      lines.push("preconnect=address-visible");
      // burner-connector starts `connected = true`, so RainbowKit auto-injects
      // the gift-box burner and hides Connect Wallet. Disconnect in-session
      // (do not reload — a reload would reconnect the burner).
      const opened = await clickFirst(page, [
        () => page.getByText(/0x[a-fA-F0-9]{2,}\.{2,}[a-fA-F0-9]+/i),
        () => page.getByText(/0x[a-fA-F0-9]{4}/i),
        () => page.getByRole("button", { name: /0x/i }),
      ]);
      const disconnected = opened
        ? await clickFirst(page, [
            () => page.getByRole("button", { name: /disconnect/i }),
            () => page.getByText(/^disconnect$/i),
          ])
        : false;
      lines.push(`burner_disconnect=${disconnected}`);
      await delay(800);
    }

    const connectClicked = await clickFirst(page, [
      () => page.getByRole("button", { name: /connect wallet/i }),
      () => page.getByRole("button", { name: /connect/i }),
      () => page.getByText(/connect wallet/i),
    ]);
    lines.push(`connect_click=${connectClicked}`);

    const metamaskRow = await clickFirst(page, [
      () => page.getByText(/^metamask$/i),
      () => page.getByRole("button", { name: /metamask/i }),
      () => page.getByText(/metamask/i),
    ]);
    lines.push(`metamask_row=${metamaskRow}`);

    const approved = await firstTrue([
      metamaskAction(prepared.wallet, "approve"),
      clickExtensionDialog(ctx, "connect"),
    ]);
    lines.push(`metamask_connect=${approved ? "approved" : "no-popup-or-failed"}`);
    await dismissRainbowKit(page);
    await delay(800);

    const paymentsUrl = `${url.replace(/\/$/, "")}/payments`;
    await page.goto(paymentsUrl, { waitUntil: "load", timeout: 45_000 });
    await waitForDappReady(page);
    await dismissRainbowKit(page);
    const payFormReady = await waitForPayForm(page);
    lines.push(`payments_nav=true`, `payments_url=${paymentsUrl}`, `pay_form_ready=${payFormReady}`);

    const amountPlan = normalizeE2eAmount(send?.amount);
    const destPlan = normalizeE2eTo(send?.to);
    if (amountPlan.invalid) lines.push(`amount_invalid=${amountPlan.invalid}`);
    lines.push(
      `amount_requested=${amountPlan.requested ?? "default"}`,
      `amount_used=${amountPlan.amount}`,
    );

    const dest = destPlan || (await firstAddressOnPage(page));
    const toFilled = dest
      ? await fillFirst(
          page,
          [
            ...(page.getByTestId ? [() => page.getByTestId!("pay-to")] : []),
            ...(page.getByPlaceholder ? [() => page.getByPlaceholder!(/0x/i)] : []),
          ],
          dest,
        )
      : false;
    await fillFirst(
      page,
      [
        ...(page.getByTestId ? [() => page.getByTestId!("pay-amount")] : []),
        ...(page.getByPlaceholder ? [() => page.getByPlaceholder!(/0\.1/i)] : []),
      ],
      amountPlan.amount,
    );
    await forceInputValue(page, "pay-amount", amountPlan.amount);
    if (dest) await forceInputValue(page, "pay-to", dest);
    const liveAmount = await readInputValue(page, "pay-amount");
    const liveTo = await readInputValue(page, "pay-to");
    const amountOk = amountsEqual(liveAmount, amountPlan.amount);
    const amountStuck = liveAmount !== "" && !amountOk;
    lines.push(`pay_form=${(liveTo || toFilled) && amountOk ? "filled" : "missing-fields"}`);
    lines.push(`to_filled=${liveTo || dest || "none"}`);
    lines.push(`amount_filled=${liveAmount || "none"}`);
    if (amountStuck) lines.push("amount_mismatch=input-kept-default");

    const beforeHashes = collectTxHashes(await page.content().catch(() => ""));
    lines.push(`pre_send_tx=${beforeHashes.size > 0 ? "stale-history" : "none"}`);

    const canSend = Boolean(liveTo || dest) && amountOk;
    const sendClicked = canSend
      ? await clickFirst(page, [
          ...(page.getByTestId ? [() => page.getByTestId!("pay-send")] : []),
          () => page.getByRole("button", { name: /send hbar/i }),
          () => page.getByRole("button", { name: /send/i }),
        ])
      : false;
    lines.push(`send_click=${sendClicked}`);

    const signed = sendClicked
      ? await firstTrue([
          metamaskAction(prepared.wallet, "confirmTransaction"),
          clickExtensionDialog(ctx, "confirm"),
        ])
      : false;
    lines.push(`metamask_sign=${signed ? "confirmed" : "no-popup-or-failed"}`);

    const afterHtml = await waitForNewTxHash(page, beforeHashes);
    const afterHashes = collectTxHashes(afterHtml);
    const newHash = [...afterHashes].some(hash => !beforeHashes.has(hash));
    const hashscanVisible = HASHSCAN_RE.test(afterHtml);
    lines.push(`tx=${newHash ? "new" : afterHashes.size > 0 ? "stale" : "missing"}`);
    lines.push(`hashscan=${hashscanVisible ? "link-visible" : "none"}`);
    lines.push(
      approved && signed && newHash && amountOk
        ? "metamask_e2e=ok"
        : "metamask_e2e=incomplete — quote amount_filled from this tool, never the requested amount",
    );
    return lines.join("\n");
  } finally {
    await prepared.context.close().catch(() => undefined);
  }
}

function clearDappWalletStorage(): void {
  const g = globalThis as {
    location?: { hostname: string; protocol?: string };
    localStorage?: { clear: () => void };
    sessionStorage?: { clear: () => void };
  };
  const host = g.location?.hostname ?? "";
  const protocol = g.location?.protocol ?? "";
  if (protocol === "chrome-extension:") return;
  if (host !== "localhost" && host !== "127.0.0.1") return;
  try {
    g.localStorage?.clear();
    g.sessionStorage?.clear();
  } catch {
    // ignore
  }
}

async function firstAddressOnPage(page: PageLike): Promise<string> {
  try {
    const found = await page.evaluate(() => {
      const match = document.body.innerText.match(/0x[a-fA-F0-9]{40}/);
      return match?.[0] ?? "";
    });
    return typeof found === "string" && /^0x[a-fA-F0-9]{40}$/.test(found) ? found : "";
  } catch {
    return "";
  }
}

async function fillFirst(
  page: PageLike,
  locators: Array<() => LocatorLike>,
  value: string,
): Promise<boolean> {
  for (const make of locators) {
    const loc = make().first();
    try {
      if (await loc.isVisible({ timeout: 4000 })) {
        if (!loc.fill) return false;
        await loc.fill("", { timeout: 4000 }).catch(() => undefined);
        await loc.fill(value, { timeout: 4000 });
        return true;
      }
    } catch {
      // try next
    }
  }
  void page;
  return false;
}

export function normalizeE2eAmount(raw?: string): {
  amount: string;
  requested: string | undefined;
  invalid?: string;
} {
  const requested = raw?.trim();
  if (!requested) return { amount: DEFAULT_SEND_AMOUNT_HBAR, requested: undefined };
  const n = Number(requested.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    return { amount: DEFAULT_SEND_AMOUNT_HBAR, requested, invalid: requested };
  }
  const amount = n.toFixed(8).replace(/\.?0+$/, "") || DEFAULT_SEND_AMOUNT_HBAR;
  return { amount, requested };
}

export function normalizeE2eTo(raw?: string): string {
  const value = raw?.trim() ?? "";
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value : "";
}

function amountsEqual(a: string, b: string): boolean {
  const left = Number(a.replace(",", "."));
  const right = Number(b.replace(",", "."));
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

async function readInputValue(page: PageLike, testId: string): Promise<string> {
  try {
    if (page.getByTestId) {
      const value = await page.getByTestId(testId).first().inputValue?.({ timeout: 2000 });
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
    // evaluate fallback
  }
  try {
    const value = await page.evaluate(id => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      return el instanceof HTMLInputElement ? el.value : "";
    }, testId);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

async function forceInputValue(page: PageLike, testId: string, value: string): Promise<void> {
  try {
    await page.evaluate(
      ({ id, next }) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!(el instanceof HTMLInputElement)) return false;
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        desc?.set?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      { id: testId, next: value },
    );
  } catch {
    // locator fill already tried
  }
}

export async function waitForDappReady(page: PageLike): Promise<{ css: boolean; js: boolean }> {
  try {
    await page.waitForLoadState?.("load", { timeout: 20_000 });
  } catch {
    // keep going
  }
  try {
    await page.waitForLoadState?.("networkidle", { timeout: 12_000 });
  } catch {
    // Next.js HMR often never reaches networkidle
  }
  await delay(1500);
  try {
    const stats = (await page.evaluate(async () => {
      const ping = async (url: string) => {
        try {
          const res = await fetch(url, { cache: "no-store" });
          return res.ok;
        } catch {
          return false;
        }
      };
      const cssHrefs = [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map(el => el.getAttribute("href") || "")
        .filter(Boolean)
        .map(href => new URL(href, location.href).href);
      const jsSrcs = [...document.querySelectorAll('script[src*="_next"]')]
        .map(el => el.getAttribute("src") || "")
        .filter(Boolean)
        .map(src => new URL(src, location.href).href);
      const cssOk =
        cssHrefs.length > 0 && (await Promise.all(cssHrefs.map(ping))).every(Boolean);
      const jsOk = jsSrcs.length > 0 && (await Promise.all(jsSrcs.slice(0, 4).map(ping))).every(Boolean);
      return { cssOk, jsOk };
    })) as { cssOk: boolean; jsOk: boolean };
    return { css: stats.cssOk, js: stats.jsOk };
  } catch {
    return { css: false, js: false };
  }
}

async function metamaskAction(wallet: DappwrightWallet, action: "approve" | "confirmTransaction"): Promise<boolean> {
  try {
    await wallet[action]();
    return true;
  } catch {
    return false;
  }
}

async function firstTrue(tasks: Array<Promise<boolean>>): Promise<boolean> {
  return await new Promise(resolve => {
    let pending = tasks.length;
    if (pending === 0) {
      resolve(false);
      return;
    }
    for (const task of tasks) {
      void Promise.resolve(task)
        .then(ok => {
          if (ok) {
            resolve(true);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(false);
        })
        .catch(() => {
          pending -= 1;
          if (pending === 0) resolve(false);
        });
    }
  });
}

async function clickExtensionDialog(
  context: { pages: () => unknown[] },
  kind: "connect" | "confirm",
): Promise<boolean> {
  const names =
    kind === "connect"
      ? [/^(next|connect|approve)$/i, /connect/i, /next/i]
      : [/^(confirm|approve|sign)$/i, /confirm/i, /sign/i];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const raw of context.pages()) {
      const page = raw as PageLike;
      let url = "";
      try {
        url = page.url();
      } catch {
        continue;
      }
      if (!url.startsWith("chrome-extension://")) continue;
      const locators: Array<() => LocatorLike> = names.map(
        name => () => page.getByRole("button", { name }),
      );
      if (page.getByTestId) {
        locators.push(
          () => page.getByTestId!("confirm-footer-button"),
          () => page.getByTestId!("page-container-footer-next"),
        );
      }
      const clicked = await clickFirst(page, locators);
      if (clicked) {
        await delay(500);
        await clickFirst(page, locators);
        return true;
      }
    }
    await delay(400);
  }
  return false;
}

async function dismissRainbowKit(page: PageLike): Promise<void> {
  try {
    await page.keyboard?.press("Escape");
  } catch {
    // keep going
  }
  await clickFirst(page, [
    () => page.getByRole("button", { name: /close/i }),
    () => page.getByRole("button", { name: /^×$/ }),
  ]).catch(() => false);
  await delay(300);
}

async function waitForPayForm(page: PageLike): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (page.getByTestId) {
      try {
        if (await page.getByTestId("pay-to").first().isVisible({ timeout: 800 })) return true;
      } catch {
        // retry
      }
    }
    await dismissRainbowKit(page);
    await delay(400);
  }
  return false;
}

function collectTxHashes(html: string): Set<string> {
  const found = new Set<string>();
  for (const match of html.matchAll(/0x[a-fA-F0-9]{64}/g)) {
    found.add(match[0].toLowerCase());
  }
  return found;
}

async function waitForNewTxHash(page: PageLike, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 20_000;
  let html = "";
  while (Date.now() < deadline) {
    html = await page.content().catch(() => "");
    const after = collectTxHashes(html);
    if ([...after].some(hash => !before.has(hash))) return html;
    if (page.getByTestId) {
      try {
        if (await page.getByTestId("pay-tx-hash").first().isVisible({ timeout: 400 })) {
          html = await page.content().catch(() => html);
          const afterVisible = collectTxHashes(html);
          if ([...afterVisible].some(hash => !before.has(hash))) return html;
        }
      } catch {
        // keep polling
      }
    }
    await delay(500);
  }
  return html || (await page.content().catch(() => ""));
}

async function visible(locator: LocatorLike): Promise<boolean> {
  try {
    return await locator.first().isVisible({ timeout: 2500 });
  } catch {
    return false;
  }
}

async function clickFirst(page: PageLike, locators: Array<() => LocatorLike>): Promise<boolean> {
  for (const make of locators) {
    const loc = make().first();
    try {
      if (await loc.isVisible({ timeout: 8000 })) {
        await loc.click({ timeout: 8000 });
        return true;
      }
    } catch {
      // try next
    }
  }
  void page;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function detectLiveAppUrl(preferred?: string): Promise<string> {
  const urls: string[] = [];
  if (preferred?.trim()) urls.push(preferred.trim().replace(/\/$/, ""));
  for (const host of ["127.0.0.1", "localhost"]) {
    for (const port of LIVE_PORTS) urls.push(`http://${host}:${port}`);
  }
  const seen = new Set<string>();
  let fallback = urls[0] ?? DEFAULT_APP_URL;
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    if (!(await isHttpOk(url))) continue;
    fallback = url;
    const health = await inspectNextAssetHealth(url);
    if (health.cssOk && health.jsOk) return url;
  }
  return fallback;
}

function isHttpOk(url: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname || "/",
          method: "GET",
          timeout: 800,
        },
        res => {
          res.resume();
          resolve((res.statusCode ?? 500) < 500);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}
