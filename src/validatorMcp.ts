import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  withPlaywrightMcpSnapshot,
  writePlaywrightMcpConfig,
} from "./contextVendor.js";
import { AGENT_PRESETS, type AgentPresetName } from "./specDefaults.js";

export interface ValidatorMcpContext {
  agent: AgentPresetName;
  workspacePath: string;
  /** Harness-owned directory for config and Playwright MCP session output. */
  artifactsDirectory: string;
}

/**
 * Deliver one authoritative Playwright MCP server to the validator CLI.
 *
 * Claude accepts a config path, so its config stays entirely under harness
 * artifacts. Cursor reads a fixed workspace file, which is snapshotted and
 * restored around the validator invocation.
 */
export async function withValidatorMcp<T>(
  context: ValidatorMcpContext,
  run: (extraValidatorArgs: string[]) => Promise<T>,
): Promise<T> {
  const delivery = AGENT_PRESETS[context.agent].mcp;
  const mcpDirectory = path.join(context.artifactsDirectory, "mcp");
  const outputDirectory = path.join(mcpDirectory, "output");
  await mkdir(outputDirectory, { recursive: true });

  if (delivery.kind === "config-flag") {
    const configPath = path.join(mcpDirectory, "playwright.json");
    await writePlaywrightMcpConfig(configPath, context.workspacePath);
    return run([delivery.flag, configPath, "--strict-mcp-config"]);
  }

  return withPlaywrightMcpSnapshot(
    context.workspacePath,
    delivery.path,
    () => run([]),
    outputDirectory,
  );
}
