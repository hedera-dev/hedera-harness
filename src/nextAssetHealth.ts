/**
 * Next.js can return HTML 200 while `/_next/static/css/app/layout.css` 404s.
 * That is a stale `.next` mix (dev HTML + leftover `next build` hashes), not
 * an old Next version. Unstyled Tailwind then shows the Hedera SVG at 1200px.
 */

export interface NextAssetHealth {
  htmlOk: boolean;
  /** True when there are no `_next` stylesheets, or every one returns 200. */
  cssOk: boolean;
  jsOk: boolean;
  missing: string[];
  hasNextAssets: boolean;
}

const CSS_HREF_RE = /<link\b[^>]*href=["']([^"']+_next[^"']+\.css[^"']*)["'][^>]*>/gi;
const SCRIPT_SRC_RE = /<script\b[^>]*src=["']([^"']+_next[^"']+\.js[^"']*)["'][^>]*>/gi;

export async function inspectNextAssetHealth(baseUrl: string): Promise<NextAssetHealth> {
  const origin = baseUrl.replace(/\/$/, "");
  let html = "";
  try {
    const response = await fetch(`${origin}/`, { redirect: "follow" });
    if (!response.ok) {
      return { htmlOk: false, cssOk: false, jsOk: false, missing: [], hasNextAssets: false };
    }
    html = await response.text();
  } catch {
    return { htmlOk: false, cssOk: false, jsOk: false, missing: [], hasNextAssets: false };
  }

  const cssHrefs = unique(matchAll(html, CSS_HREF_RE)).slice(0, 6);
  const scriptSrcs = unique(matchAll(html, SCRIPT_SRC_RE)).slice(0, 6);
  const hasNextAssets = cssHrefs.length > 0 || scriptSrcs.length > 0;
  if (!hasNextAssets) {
    return { htmlOk: true, cssOk: true, jsOk: true, missing: [], hasNextAssets: false };
  }

  const missing: string[] = [];
  for (const href of cssHrefs) {
    const url = resolveAsset(origin, href);
    if (!(await isGetOk(url))) missing.push(url);
  }
  for (const src of scriptSrcs) {
    const url = resolveAsset(origin, src);
    if (!(await isGetOk(url))) missing.push(url);
  }

  const cssMissing = missing.filter(url => url.includes(".css"));
  const jsMissing = missing.filter(url => url.includes(".js"));
  return {
    htmlOk: true,
    cssOk: cssHrefs.length === 0 || cssMissing.length === 0,
    jsOk: scriptSrcs.length === 0 || jsMissing.length === 0,
    missing,
    hasNextAssets: true,
  };
}

export function nextAssetHealthHint(health: NextAssetHealth): string {
  if (health.cssOk && health.jsOk) return "";
  const sample = health.missing[0] ?? "a /_next/static asset";
  return [
    `Next.js HTML is 200 but ${sample} 404s.`,
    "Stale packages/nextjs/.next (dev HTML mixed with a leftover next build).",
    "Stop the server, delete packages/nextjs/.next, restart yarn next:dev.",
    "The giant Hedera H is the unstyled SVG, not an old Next version.",
  ].join(" ");
}

function matchAll(html: string, re: RegExp): string[] {
  const out: string[] = [];
  re.lastIndex = 0;
  for (const match of html.matchAll(re)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveAsset(origin: string, href: string): string {
  try {
    return new URL(href, `${origin}/`).toString();
  } catch {
    return href;
  }
}

async function isGetOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    return response.ok;
  } catch {
    return false;
  }
}
