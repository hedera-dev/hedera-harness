import { readFile } from "node:fs/promises";
import type { Browser, Page, Response } from "playwright";
import { parse as parseYaml } from "yaml";
import { importPlaywright } from "../optionalDeps.js";
import type { PlaywrightGateResult, PlaywrightGateRouteResult, ValidationFinding } from "../types.js";
import {
  startDevServer,
  stopDevServer,
  waitForServer,
  type DevServerHandle,
  type DevServerSession,
} from "./devServer.js";

interface PlaywrightGateConfig {
  name?: string;
  server: {
    command: string;
    url: string;
    timeoutMs?: number;
  };
  defaults?: {
    timeoutMs?: number;
    failOnConsoleError?: boolean;
  };
  routes: Array<{
    name: string;
    path: string;
  }>;
  forbidden?: {
    visibleText?: string[];
  };
}

export async function runPlaywrightGate(
  workspacePath: string,
  configPath: string,
  existingDevServer?: DevServerSession,
): Promise<{ result: PlaywrightGateResult; findings: ValidationFinding[] }> {
  const startedAt = Date.now();
  const config = await loadPlaywrightGateConfig(configPath);
  const serverTimeoutMs = config.server.timeoutMs ?? 120_000;
  const routeTimeoutMs = config.defaults?.timeoutMs ?? 30_000;
  const failOnConsoleError = config.defaults?.failOnConsoleError ?? true;
  const forbiddenText = config.forbidden?.visibleText ?? [];

  let serverHandle: DevServerHandle | null = null;
  let ownsServer = false;
  let browser: Browser | null = null;
  let serverUrl = existingDevServer?.url ?? config.server.url;
  const routeResults: PlaywrightGateRouteResult[] = [];
  const findings: ValidationFinding[] = [];

  try {
    if (existingDevServer) {
      serverUrl = existingDevServer.url;
    } else {
      ownsServer = true;
      serverHandle = startDevServer(workspacePath, config.server.command, config.server.url, "playwright");
      serverUrl = await serverHandle.detectedUrl;

      if (serverUrl !== config.server.url) {
        console.log(
          `[hedera-harness] Playwright gate using detected dev server ${serverUrl} (config specified ${config.server.url})`,
        );
      }

      await waitForServer(serverUrl, serverTimeoutMs);
    }

    const { chromium } = await importPlaywright();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    for (const route of config.routes) {
      const routeStartedAt = Date.now();
      const routeUrl = joinUrl(serverUrl, route.path);
      const consoleErrors: string[] = [];
      const consoleListener = (message: { type: () => string; text: () => string }) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      };

      page.on("console", consoleListener);

      let response: Response | null = null;
      let rendered = false;
      let statusCode: number | null = null;

      try {
        response = await page.goto(routeUrl, {
          waitUntil: "domcontentloaded",
          timeout: routeTimeoutMs,
        });
        statusCode = response?.status() ?? null;

        const bodyText = (await page.locator("body").innerText({ timeout: 5_000 })).trim();
        rendered = bodyText.length >= 20;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        findings.push({
          id: `playwright:route:${route.name}:navigation`,
          category: "playwright",
          message: `Playwright gate failed to load route ${route.path} (${route.name})`,
          details: message,
        });
      } finally {
        page.off("console", consoleListener);
      }

      const forbiddenTextFound: string[] = [];
      for (const text of forbiddenText) {
        if (await pageContainsText(page, text)) {
          forbiddenTextFound.push(text);
        }
      }
      if (statusCode !== null && statusCode >= 400) {
        findings.push({
          id: `playwright:route:${route.name}:status`,
          category: "playwright",
          message: `Playwright gate route ${route.path} returned HTTP ${statusCode}`,
        });
      }

      if (!rendered) {
        findings.push({
          id: `playwright:route:${route.name}:render`,
          category: "playwright",
          message: `Playwright gate route ${route.path} did not render meaningful page content`,
        });
      }

      if (failOnConsoleError && consoleErrors.length > 0) {
        findings.push({
          id: `playwright:route:${route.name}:console`,
          category: "playwright",
          message: `Playwright gate route ${route.path} logged browser console errors`,
          details: truncateList(consoleErrors),
        });
      }

      for (const text of forbiddenTextFound) {
        findings.push({
          id: `playwright:route:${route.name}:forbidden:${slugify(text)}`,
          category: "playwright",
          message: `Playwright gate route ${route.path} contains forbidden text: "${text}"`,
        });
      }

      routeResults.push({
        name: route.name,
        path: route.path,
        statusCode,
        rendered,
        consoleErrors,
        forbiddenTextFound,
        durationMs: Date.now() - routeStartedAt,
      });
    }

    await context.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    findings.push({
      id: "playwright:gate",
      category: "playwright",
      message: "Playwright gate failed before route checks completed",
      details: message,
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    if (ownsServer) {
      await stopDevServer(serverHandle);
    }
  }

  const result: PlaywrightGateResult = {
    passed: findings.length === 0,
    configPath,
    serverUrl,
    serverCommand: existingDevServer?.serverCommand ?? config.server.command,
    routes: routeResults,
    durationMs: Date.now() - startedAt,
  };

  return { result, findings };
}

async function loadPlaywrightGateConfig(configPath: string): Promise<PlaywrightGateConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parseYaml(raw) as PlaywrightGateConfig;

  if (!parsed.server?.command || !parsed.server?.url) {
    throw new Error(`Playwright gate config ${configPath} requires server.command and server.url.`);
  }

  if (!Array.isArray(parsed.routes) || parsed.routes.length === 0) {
    throw new Error(`Playwright gate config ${configPath} requires at least one route.`);
  }

  return parsed;
}

function joinUrl(baseUrl: string, routePath: string): string {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const joined = new URL(routePath.replace(/^\//, ""), base);
  return joined.toString();
}

async function pageContainsText(page: Page, text: string): Promise<boolean> {
  const count = await page.getByText(text, { exact: false }).count();
  return count > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

function truncateList(values: string[], maxItems = 5, maxLength = 800): string {
  const joined = values
    .slice(0, maxItems)
    .map(value => truncate(value, 200))
    .join("\n");
  if (values.length > maxItems) {
    return `${joined}\n...and ${values.length - maxItems} more`;
  }
  return joined.slice(0, maxLength);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "text";
}
