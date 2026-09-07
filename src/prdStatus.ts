import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type PrdKind = "missing" | "skeleton" | "real";

export interface PrdStatus {
  kind: PrdKind;
  path?: string;
  reason: string;
}

/**
 * Init copies skeletons/project-harness/prd.md. That file is a placeholder,
 * not a product brief. GENERATE must not run against it.
 */
export function classifyPrdContent(text: string): "skeleton" | "real" {
  const body = text.replace(/\r\n/g, "\n").trim();
  if (!body) return "skeleton";
  if (/feature brief\s*\(edit me\)/i.test(body)) return "skeleton";
  if (/describe the feature you want the harness agent to implement/i.test(body)) {
    return "skeleton";
  }
  return "real";
}

export function inspectWorkspacePrd(workspaceDir: string): PrdStatus {
  const root = path.resolve(workspaceDir);
  const candidates = listPrdCandidates(root);
  let skeleton: PrdStatus | undefined;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const kind = classifyPrdContent(readFileSync(candidate, "utf8"));
    const rel = toRel(root, candidate);
    if (kind === "real") {
      return {
        kind: "real",
        path: rel,
        reason: "A real PRD is present.",
      };
    }
    skeleton ??= {
      kind: "skeleton",
      path: rel,
      reason:
        'Init template ("edit me"), not a real PRD. Interview the human. Do not GENERATE from this file.',
    };
  }
  if (skeleton) return skeleton;
  return {
    kind: "missing",
    reason: "No PRD file. Interview the human for the idea; do not GENERATE.",
  };
}

/** Spec `prd:` (string or list), then `.harness/prds/*.md` newest-last, then prd.md. */
export function listPrdCandidates(workspaceDir: string): string[] {
  const root = path.resolve(workspaceDir);
  const found: string[] = [];
  const specPath = path.join(root, ".harness", "spec.yaml");
  if (existsSync(specPath)) {
    for (const rel of readSpecPrdPaths(readFileSync(specPath, "utf8"))) {
      found.push(path.resolve(root, rel));
    }
  }
  const prdsDir = path.join(root, ".harness", "prds");
  if (existsSync(prdsDir)) {
    const numbered = readdirSync(prdsDir)
      .filter(name => name.toLowerCase().endsWith(".md"))
      .sort()
      .map(name => path.join(prdsDir, name));
    found.push(...numbered);
  }
  found.push(path.join(root, ".harness", "prd.md"));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of found) {
    const key = path.normalize(file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function toRel(root: string, file: string): string {
  return (path.relative(root, file) || file).replaceAll("\\", "/");
}

function readSpecPrdPaths(specText: string): string[] {
  const lines = specText.split(/\r?\n/);
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = line.match(/^\s*prd:\s+(\S.*?)\s*$/);
    if (inline?.[1] && !inline[1].startsWith("#")) {
      const value = inline[1].replace(/^["']|["']$/g, "").trim();
      if (value && value !== "|" && value !== ">") paths.push(value);
      continue;
    }
    if (!/^\s*prd:\s*$/.test(line)) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      const item = lines[j].match(/^\s*-\s+(\S.*?)\s*$/);
      if (!item) break;
      const value = item[1].replace(/^["']|["']$/g, "").trim();
      if (value) paths.push(value);
    }
  }
  return paths;
}
