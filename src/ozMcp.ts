import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContractBase, ContractScope } from "./contractScope.js";

export const OPENZEPPELIN_MCP_NAME = "openzeppelin-solidity";
export const OPENZEPPELIN_MCP_URL = "https://mcp.openzeppelin.com/contracts/solidity/mcp";

export type OzMcpKind = "ready" | "disabled" | "missing";

export interface OzMcpHit {
  file: string;
  name: string;
  container: "mcp" | "mcp.servers";
  enabled: boolean;
}

export interface OzMcpStatus {
  kind: OzMcpKind;
  hits: OzMcpHit[];
  projectConfig: string;
  restartHint: string;
}

export function ozMcpNeeded(contracts: ContractScope, contractBase: ContractBase): boolean {
  return contracts === "solidity" && contractBase !== "hts" && contractBase !== "none";
}

export function projectOpencodeConfigPath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), "opencode.json");
}

export function inspectOzMcp(workspaceDir: string): OzMcpStatus {
  const projectConfig = projectOpencodeConfigPath(workspaceDir);
  const hits: OzMcpHit[] = [];
  for (const file of uniquePaths([
    projectConfig,
    path.join(path.resolve(workspaceDir), ".opencode", "opencode.json"),
  ])) {
    hits.push(...findOzHits(file));
  }
  const enabled = hits.some(hit => hit.enabled);
  const disabled = hits.some(hit => !hit.enabled);
  const kind: OzMcpKind = enabled ? "ready" : disabled ? "disabled" : "missing";
  return {
    kind,
    hits,
    projectConfig,
    restartHint:
      "OpenCode loads MCP at session start. After enable, start a new opencode session for OpenZeppelin tools to appear. This session may keep using @openzeppelin/contracts imports.",
  };
}

export function formatOzMcpStatus(status: OzMcpStatus): string {
  const hitLines =
    status.hits.length === 0
      ? ["hit=none"]
      : status.hits.map(
          hit =>
            `hit=${hit.enabled ? "on" : "off"} name=${hit.name} container=${hit.container} file=${hit.file}`,
        );
  return [
    `kind=${status.kind}`,
    ...hitLines,
    `project_config=${status.projectConfig}`,
    `restart=${status.restartHint}`,
    "mcp=openzeppelin-solidity",
  ].join("\n");
}

/** Flip enabled:true on the first disabled project entry, or write the overlay snippet. Never ~/.config/opencode. */
export function enableOzMcp(workspaceDir: string): OzMcpStatus {
  const before = inspectOzMcp(workspaceDir);
  const disabled = before.hits.find(hit => !hit.enabled);
  if (disabled) {
    const parsed = readJsonObject(disabled.file);
    const entry = locateEntry(parsed, disabled);
    if (entry) {
      entry.record.enabled = true;
      if ("disabled" in entry.record) delete entry.record.disabled;
    }
    writeJsonObject(disabled.file, parsed);
    return inspectOzMcp(workspaceDir);
  }
  if (before.kind === "ready") return before;
  const file = projectOpencodeConfigPath(workspaceDir);
  const parsed = existsSync(file) ? readJsonObject(file) : {};
  const mcp = asRecord(parsed.mcp) ?? {};
  const snippet: Record<string, unknown> = {
    type: "remote",
    url: OPENZEPPELIN_MCP_URL,
    enabled: true,
    oauth: false,
    timeout: 20000,
  };
  const servers = asRecord(mcp.servers);
  if (servers && asRecord(servers[OPENZEPPELIN_MCP_NAME])) {
    const next = { ...asRecord(servers[OPENZEPPELIN_MCP_NAME]), ...snippet };
    delete next.disabled;
    servers[OPENZEPPELIN_MCP_NAME] = next;
  } else {
    const next = { ...asRecord(mcp[OPENZEPPELIN_MCP_NAME]), ...snippet };
    delete next.disabled;
    mcp[OPENZEPPELIN_MCP_NAME] = next;
    parsed.mcp = mcp;
  }
  writeJsonObject(file, parsed);
  return inspectOzMcp(workspaceDir);
}

export function ensureOzMcpForContracts(
  workspaceDir: string,
  contracts: ContractScope,
  contractBase: ContractBase,
): { status: OzMcpStatus; skipped: boolean; justEnabled: boolean } {
  if (!ozMcpNeeded(contracts, contractBase)) {
    return { status: inspectOzMcp(workspaceDir), skipped: true, justEnabled: false };
  }
  const before = inspectOzMcp(workspaceDir);
  if (before.kind === "ready") {
    return { status: before, skipped: false, justEnabled: false };
  }
  return { status: enableOzMcp(workspaceDir), skipped: false, justEnabled: true };
}

function findOzHits(file: string): OzMcpHit[] {
  if (!existsSync(file)) return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = readJsonObject(file);
  } catch {
    return [];
  }
  const hits: OzMcpHit[] = [];
  const mcp = asRecord(parsed.mcp);
  if (!mcp) return hits;
  const servers = asRecord(mcp.servers);
  if (servers) {
    for (const [name, value] of Object.entries(servers)) {
      if (name !== OPENZEPPELIN_MCP_NAME) continue;
      hits.push({
        file,
        name,
        container: "mcp.servers",
        enabled: isEntryEnabled(value),
      });
    }
  }
  for (const [name, value] of Object.entries(mcp)) {
    if (name === "servers") continue;
    if (name !== OPENZEPPELIN_MCP_NAME) continue;
    hits.push({
      file,
      name,
      container: "mcp",
      enabled: isEntryEnabled(value),
    });
  }
  return hits;
}

function isEntryEnabled(value: unknown): boolean {
  const record = asRecord(value) ?? {};
  if (record.enabled === false || record.disabled === true) return false;
  return true;
}

function locateEntry(
  parsed: Record<string, unknown>,
  hit: OzMcpHit,
): { record: Record<string, unknown> } | undefined {
  const mcp = asRecord(parsed.mcp);
  if (!mcp) return undefined;
  if (hit.container === "mcp.servers") {
    const servers = asRecord(mcp.servers);
    const record = asRecord(servers?.[hit.name]);
    return record ? { record } : undefined;
  }
  const record = asRecord(mcp[hit.name]);
  return record ? { record } : undefined;
}

function uniquePaths(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    const key = path.normalize(file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readJsonObject(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonObject(file: string, value: Record<string, unknown>): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
