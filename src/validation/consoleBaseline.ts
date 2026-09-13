import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlaywrightGateRouteResult } from "../types.js";

/**
 * Browser console errors the app already logged before the agent touched it.
 *
 * The SMOKE gate fails a route on any console error, which reads every piece of
 * pre-existing noise as something this attempt broke. A stock scaffold app logs
 * plenty with no agent involved — an unset WalletConnect id, a price feed that
 * needs network — so the gate could fail every attempt for a condition no
 * repair prompt can fix.
 */
export interface ConsoleBaseline {
  /** Normalized texts per route name, for noise that belongs to one page. */
  byRoute: Record<string, string[]>;
  /**
   * Every normalized text seen on any baselined route.
   *
   * App-wide noise follows the user onto pages that did not exist yet: a route
   * the agent creates inherits whatever the layout logs, so it has no baseline
   * of its own to compare against.
   */
  anyRoute: string[];
}

/**
 * Strip the parts that differ between two boots of the same failure.
 *
 * The same fetch failure prints a fresh port, request id or timestamp each run,
 * so raw text would never match twice.
 */
export function normalizeConsoleError(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, "<url>")
    .replace(/\b0x[0-9a-f]{6,}\b/g, "<hex>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildConsoleBaseline(
  routes: Pick<PlaywrightGateRouteResult, "name" | "consoleErrors" | "statusCode">[],
): ConsoleBaseline {
  const byRoute: Record<string, string[]> = {};
  const anyRoute = new Set<string>();

  for (const route of routes) {
    // Only a page that already loads has noise worth remembering. A route the
    // agent has not created yet answers 404, and Chromium logs that as "Failed
    // to load resource: ... 404 (Not Found)". Recording it would hide the same
    // text later, when the new page points at an image or script that is missing.
    if (route.statusCode === null || (route.statusCode ?? 0) >= 400) continue;
    const normalized = route.consoleErrors.map(normalizeConsoleError).filter(Boolean);
    byRoute[route.name] = [...new Set(normalized)];
    for (const error of normalized) anyRoute.add(error);
  }

  return { byRoute, anyRoute: [...anyRoute] };
}

/** The console errors on this route that the baseline did not already contain. */
export function newConsoleErrors(
  routeName: string,
  consoleErrors: string[],
  baseline?: ConsoleBaseline,
): string[] {
  if (!baseline) return consoleErrors;

  const known = new Set([...(baseline.byRoute[routeName] ?? []), ...baseline.anyRoute]);
  return consoleErrors.filter(error => !known.has(normalizeConsoleError(error)));
}

/** Cached beside the install fingerprint so `--continue` reuses it. */
export const CONSOLE_BASELINE_FILE = "console-baseline.json";

export async function readConsoleBaseline(
  cacheDirectory: string,
): Promise<ConsoleBaseline | undefined> {
  try {
    const raw = await readFile(path.join(cacheDirectory, CONSOLE_BASELINE_FILE), "utf8");
    const parsed = JSON.parse(raw) as ConsoleBaseline;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.anyRoute)) return undefined;
    return { byRoute: parsed.byRoute ?? {}, anyRoute: parsed.anyRoute };
  } catch {
    // Absent or unreadable: the run simply has no baseline to subtract.
    return undefined;
  }
}

export async function writeConsoleBaseline(
  cacheDirectory: string,
  baseline: ConsoleBaseline,
): Promise<void> {
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(
    path.join(cacheDirectory, CONSOLE_BASELINE_FILE),
    `${JSON.stringify(baseline, null, 2)}\n`,
    "utf8",
  );
}
