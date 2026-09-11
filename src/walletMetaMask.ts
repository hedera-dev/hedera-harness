import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  chromeProfilePath,
  isMetaMaskImported,
  readVaultFile,
  writeMetaMaskImportedMarker,
} from "./walletVault.js";

/** Hardhat/dappwright throwaway SRP — only to finish MetaMask onboarding. Funds live on the imported portal key. */
export const DISPOSABLE_ONBOARDING_SEED =
  "test test test test test test test test test test test junk";

export const HEDERA_TESTNET = {
  networkName: "Hedera Testnet",
  rpc: "https://testnet.hashio.io/api",
  chainId: 296,
  symbol: "HBAR",
} as const;

export const IMPORTED_ACCOUNT_NAME = "Imported Account";

export function privateKeyForImport(vaultKey: string): string {
  return vaultKey.trim().replace(/^0x/i, "");
}

export function isBenignImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already imported|already exists|duplicate/i.test(message);
}

export function formatWalletBrowserLog(input: {
  firstRun: boolean;
  profile: string;
  metamaskVersion: string;
}): string {
  return [
    "browser=chromium-persistent",
    "wallet=metamask",
    `metamask_version=${input.metamaskVersion}`,
    `profile=${input.profile}`,
    input.firstRun
      ? "import=running (dappwright downloads MetaMask, onboards, importPK, Hedera Testnet)"
      : "import=reuse (unlock existing profile; MetaMask stays imported)",
    "testnet_only=true",
    "never_print_keys=true",
    "Leave this Chromium open while you test. Ctrl+C to close.",
  ].join("\n");
}

interface PreparedWallet {
  context: {
    close: () => Promise<unknown>;
    pages: () => unknown[];
    newPage: () => Promise<unknown>;
  };
  wallet: DappwrightWallet;
  firstRun: boolean;
  metamaskVersion: string;
  profile: string;
}

export interface DappwrightWallet {
  approve: () => Promise<void>;
  confirmTransaction: () => Promise<void>;
  page?: { url?: () => string };
}

/**
 * dappwright `launch()` / `bootstrap()` always wipe os.tmpdir()/dappwright/session.
 * We download the unpacked extension ourselves and persist Chromium under `.harness/wallet/`.
 */
/** Chromium can be visible while dappwright getWallet/unlock never returns (locked profile). */
export const METAMASK_HANDSHAKE_TIMEOUT_MS = 60_000;

export async function launchPreparedWalletBrowser(
  workspaceDir: string,
  hooks?: { onChromiumReady?: () => void | Promise<void> },
): Promise<PreparedWallet> {
  const vault = readVaultFile(workspaceDir);
  if (!vault) {
    throw new Error("No MetaMask test vault. Run wallet provision first — never paste a key in chat.");
  }

  const dappwright = await importDappwright();
  const playwright = await importPlaywright();
  const { MetaMaskWallet, getWallet } = dappwright;
  const version = MetaMaskWallet.recommendedVersion;
  const extensionPath = await MetaMaskWallet.download({
    wallet: "metamask",
    version,
    headless: false,
  });

  const userDataDir = chromeProfilePath(workspaceDir);
  ensureEnglishChromiumPrefs(userDataDir);
  const firstRun = !isMetaMaskImported(workspaceDir);
  releaseChromeProfile(userDataDir);

  const context = await launchPersistentWalletContext(playwright, userDataDir, extensionPath);
  await hooks?.onChromiumReady?.();

  let wallet: DappwrightWallet;
  try {
    wallet = await withTimeout(
      (async () => {
        const next = (await getWallet("metamask", context)) as DappwrightWallet & {
          unlock: (password?: string) => Promise<void>;
          setup: (options: { seed: string; password: string; showTestNets: boolean }) => Promise<void>;
          importPK: (pk: string) => Promise<void>;
          hasNetwork: (name: string) => Promise<boolean>;
          addNetwork: (options: typeof HEDERA_TESTNET) => Promise<void>;
          switchNetwork: (name: string) => Promise<void>;
          switchAccount: (name: string) => Promise<void>;
          page: UnlockableWallet["page"];
        };
        if (firstRun) {
          if (await isUnlockScreen(next)) {
            await next.unlock(vault.password);
          } else {
            await next.setup({
              seed: DISPOSABLE_ONBOARDING_SEED,
              password: vault.password,
              showTestNets: true,
            });
          }
          await importPortalKey(next, vault.privateKey);
          await ensureHederaTestnet(next);
          await switchImportedAccount(next);
          writeMetaMaskImportedMarker(workspaceDir);
        } else {
          const unlocked = await unlockIfNeeded(next, vault.password);
          if (!unlocked) {
            throw new Error(
              "MetaMask unlock failed (password field not filled). Re-run wallet provision if the vault password does not match.",
            );
          }
          await ensureHederaTestnet(next);
          await switchImportedAccount(next);
        }
        await closeExtraMetaMaskPages(context, next.page);
        return next;
      })(),
      METAMASK_HANDSHAKE_TIMEOUT_MS,
      "MetaMask handshake hung after Chromium launched (profile lock / leftover chrome).",
    );
  } catch (error) {
    await context.close().catch(() => undefined);
    releaseChromeProfile(userDataDir);
    throw error;
  }

  return {
    context: context as PreparedWallet["context"],
    wallet,
    firstRun,
    metamaskVersion: version,
    profile: userDataDir,
  };
}

async function importPortalKey(
  wallet: { importPK: (pk: string) => Promise<void> },
  vaultKey: string,
): Promise<void> {
  try {
    await wallet.importPK(privateKeyForImport(vaultKey));
  } catch (error) {
    if (!isBenignImportError(error)) throw error;
  }
}

async function ensureHederaTestnet(wallet: {
  hasNetwork: (name: string) => Promise<boolean>;
  addNetwork: (options: typeof HEDERA_TESTNET) => Promise<void>;
  switchNetwork: (name: string) => Promise<void>;
}): Promise<void> {
  const name = HEDERA_TESTNET.networkName;
  try {
    if (await wallet.hasNetwork(name)) {
      await wallet.switchNetwork(name);
      return;
    }
  } catch {
    // addNetwork below
  }
  await wallet.addNetwork({ ...HEDERA_TESTNET });
}

async function switchImportedAccount(wallet: {
  switchAccount: (name: string) => Promise<void>;
}): Promise<void> {
  try {
    await wallet.switchAccount(IMPORTED_ACCOUNT_NAME);
  } catch {
    // Account label varies by MetaMask version; the imported key is still in the vault.
  }
}

async function unlockIfNeeded(wallet: UnlockableWallet, password: string): Promise<boolean> {
  try {
    await wallet.unlock(password);
    if (!(await isUnlockScreen(wallet, 1500))) return true;
  } catch {
    // Fall through to locators — MetaMask testids change between versions.
  }
  const page = wallet.page;
  const typed = page as UnlockPage;
  try {
    const passwordBox = firstVisible([
      () => typed.getByTestId?.("unlock-password"),
      () => typed.locator?.('input[type="password"]'),
      () => typed.getByPlaceholder?.(/password/i),
    ]);
    const field = passwordBox && (await visibleLocator(passwordBox, 5000)) ? passwordBox : undefined;
    if (!field?.fill) return false;
    await field.fill(password);
    const submit = firstVisible([
      () => typed.getByTestId?.("unlock-submit"),
      () => typed.getByRole?.("button", { name: /unlock/i }),
    ]);
    if (submit?.click) await submit.click({ timeout: 5000 });
    await delay(800);
    return !(await isUnlockScreen(wallet, 2000));
  } catch {
    return false;
  }
}

function firstVisible(
  makers: Array<() => LocatorLike | undefined>,
): LocatorLike | undefined {
  for (const make of makers) {
    try {
      const loc = make();
      if (loc) return loc;
    } catch {
      // next
    }
  }
  return undefined;
}

async function visibleLocator(locator: LocatorLike, timeout: number): Promise<boolean> {
  try {
    if (locator.first) return await locator.first().isVisible({ timeout });
    return await locator.isVisible({ timeout });
  } catch {
    return false;
  }
}

async function isUnlockScreen(wallet: UnlockableWallet, timeout = 4000): Promise<boolean> {
  try {
    if (await wallet.page.getByTestId("unlock-password").isVisible({ timeout })) return true;
  } catch {
    // try generic password field
  }
  try {
    const typed = wallet.page as UnlockPage;
    const field = typed.locator?.('input[type="password"]');
    if (field) return await visibleLocator(field, timeout);
  } catch {
    return false;
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type ClosablePage = {
  url: () => string;
  close: () => Promise<unknown>;
};

type WalletContextLike = {
  pages: () => unknown[];
};

/**
 * Leftover `chrome-extension://` tabs (notification.html / extra home.html) from a
 * previous run make RainbowKit spin on “Opening MetaMask…” with no popup.
 * Keep dappwright’s wallet.page; close the rest.
 */
export async function closeExtraMetaMaskPages(
  context: WalletContextLike,
  keep?: { url?: () => string },
): Promise<number> {
  let keepUrl = "";
  try {
    keepUrl = keep?.url?.() ?? "";
  } catch {
    keepUrl = "";
  }
  let closed = 0;
  for (const raw of context.pages()) {
    const page = raw as ClosablePage;
    let url = "";
    try {
      url = page.url();
    } catch {
      continue;
    }
    if (!url.startsWith("chrome-extension://")) continue;
    if (keepUrl && urlsMatch(url, keepUrl)) continue;
    if (!keepUrl && !isStaleMetaMaskTab(url)) continue;
    await page.close().catch(() => undefined);
    closed += 1;
  }
  return closed;
}

function urlsMatch(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/\/$/, "").split("#")[0] ?? value;
  return strip(a) === strip(b);
}

function isStaleMetaMaskTab(url: string): boolean {
  return /notification\.html|notification-ui|connect-request|confirmation/i.test(url);
}

async function launchPersistentWalletContext(
  playwright: typeof import("playwright"),
  userDataDir: string,
  extensionPath: string,
) {
  const options = {
    headless: false,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    bypassCSP: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  };
  try {
    return await playwright.chromium.launchPersistentContext(userDataDir, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/profile|lock|in use|already|SingletonLock|Target closed/i.test(message)) throw error;
    releaseChromeProfile(userDataDir);
    await delay(1200);
    return await playwright.chromium.launchPersistentContext(userDataDir, options);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

/** Kill leftover Chromium whose command line still holds this profile (Windows “sesión existente”). */
export function releaseChromeProfile(userDataDir: string): void {
  const needle = normalizePath(userDataDir);
  if (!needle) return;
  for (const row of listProfileProcesses(needle)) {
    killPid(row.pid);
  }
}

function listProfileProcesses(needle: string): Array<{ pid: number }> {
  const rows: Array<{ pid: number }> = [];
  try {
    const out =
      process.platform === "win32"
        ? execFileSync(
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome|chromium' -and $_.CommandLine } | ForEach-Object { '{0}`t{1}' -f $_.ProcessId, $_.CommandLine }",
            ],
            { encoding: "utf8", timeout: 15_000, windowsHide: true },
          )
        : execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8", timeout: 15_000 });
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      const raw = tab === -1 ? line.trim() : line;
      const match = raw.match(/^\s*(\d+)[\t ]+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const cmd = normalizePath(match[2] ?? "");
      if (pid > 0 && pid !== process.pid && cmd.includes(needle)) rows.push({ pid });
    }
  } catch {
    return rows;
  }
  return rows;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function killPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

type LocatorLike = {
  first?: () => LocatorLike;
  isVisible: (options?: { timeout?: number }) => Promise<boolean>;
  fill?: (value: string) => Promise<void>;
  click?: (options?: { timeout?: number }) => Promise<void>;
};

type UnlockPage = UnlockableWallet["page"] & {
  locator?: (selector: string) => LocatorLike;
  getByPlaceholder?: (text: RegExp) => LocatorLike;
  getByRole?: (role: "button", options?: { name?: RegExp }) => LocatorLike;
  getByTestId?: (id: string) => LocatorLike;
};

type UnlockableWallet = {
  page: {
    getByTestId: (id: string) => { isVisible: (options?: { timeout?: number }) => Promise<boolean> };
  };
  unlock: (password?: string) => Promise<void>;
};

function ensureEnglishChromiumPrefs(userDataDir: string): void {
  mkdirSync(userDataDir, { recursive: true });
  const prefsDir = path.join(userDataDir, "Default");
  const prefsFile = path.join(prefsDir, "Preferences");
  if (existsSync(prefsFile)) return;
  mkdirSync(prefsDir, { recursive: true });
  writeFileSync(
    prefsFile,
    `${JSON.stringify({ intl: { accept_languages: "en", selected_languages: "en" } })}\n`,
    "utf8",
  );
}

async function importDappwright(): Promise<typeof import("@tenkeylabs/dappwright")> {
  try {
    return await import("@tenkeylabs/dappwright");
  } catch {
    throw new Error(
      "@tenkeylabs/dappwright is required for wallet browser. In the hedera-harness repo: npm i",
    );
  }
}

async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "Playwright is required for the test browser. In the hedera-harness repo: npm i && npx playwright install chromium",
    );
  }
}
