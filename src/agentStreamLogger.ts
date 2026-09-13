import { appendFile, writeFile } from "node:fs/promises";

export interface AgentProgress {
  lastActivity: string;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  sessionId?: string;
  /** What the agent reported spending, once its final `result` event arrived. */
  usage?: AgentUsage;
}

/**
 * Spend reported by the agent CLI for one invocation.
 *
 * Claude's stream-json `result` event carries `total_cost_usd` and a `usage`
 * block; Codex reports `usage` per turn without a price; Cursor reports
 * neither. Every field is therefore optional, and `reported` says whether the
 * agent gave the harness anything at all — "unknown" is a real answer, not $0.
 */
export interface AgentUsage {
  reported: boolean;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  turns?: number;
}

export class AgentStreamLogger {
  private lineBuffer = "";
  private progress: AgentProgress = {
    lastActivity: "waiting for agent output",
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
  };

  constructor(
    private readonly activityLogPath: string,
    private readonly onProgress?: (progress: AgentProgress) => void | Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    await writeFile(
      this.activityLogPath,
      ["# agent activity log", "# one human-readable line per notable event", ""].join("\n"),
      "utf8",
    );
  }

  getProgress(): AgentProgress {
    return { ...this.progress };
  }

  async processChunk(chunk: string): Promise<void> {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.processLine(trimmed);
    }
  }

  private async processLine(line: string): Promise<void> {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }

    const summary = summarizeStreamEvent(event);
    if (!summary) return;

    if (typeof event.session_id === "string") {
      this.progress.sessionId = event.session_id;
    }

    if (event.type === "tool_call" && event.subtype === "started") {
      this.progress.toolCallsStarted += 1;
    }
    if (event.type === "tool_call" && event.subtype === "completed") {
      this.progress.toolCallsCompleted += 1;
    }

    const usage = extractUsage(event, this.progress.usage);
    if (usage) {
      this.progress.usage = usage;
    }

    this.progress.lastActivity = summary;
    await appendFile(this.activityLogPath, `${formatTimestamp()} ${summary}\n`, "utf8");
    console.log(`[hedera-harness:agent] ${summary}`);
    await this.onProgress?.(this.getProgress());
  }
}

function summarizeStreamEvent(event: Record<string, unknown>): string | null {
  const type = event.type;

  if (type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model : "unknown-model";
    return `SESSION started model=${model}`;
  }

  if (type === "tool_call") {
    const subtype = event.subtype === "started" ? "START" : event.subtype === "completed" ? "DONE" : "CALL";
    const toolCall = event.tool_call;
    if (!toolCall || typeof toolCall !== "object") {
      return `TOOL ${subtype}`;
    }

    const [toolName, payload] = Object.entries(toolCall as Record<string, unknown>).find(([key]) =>
      key.endsWith("ToolCall"),
    ) ?? ["tool", undefined];

    const args =
      payload && typeof payload === "object" && "args" in payload
        ? ((payload as { args?: Record<string, unknown> }).args ?? {})
        : {};

    if (toolName === "editToolCall" && typeof args.path === "string") {
      return `TOOL ${subtype} edit ${args.path}`;
    }

    if (toolName === "shellToolCall" || toolName === "runTerminalCommandToolCall") {
      const command = typeof args.command === "string" ? args.command : JSON.stringify(args);
      return `TOOL ${subtype} shell ${truncate(command, 160)}`;
    }

    if (toolName === "readToolCall" && typeof args.path === "string") {
      return `TOOL ${subtype} read ${args.path}`;
    }

    if (toolName === "grepToolCall" && typeof args.pattern === "string") {
      return `TOOL ${subtype} grep ${truncate(args.pattern, 80)}`;
    }

    if (toolName === "globToolCall" && typeof args.globPattern === "string") {
      return `TOOL ${subtype} glob ${args.globPattern}`;
    }

    if (toolName === "deleteToolCall" && typeof args.path === "string") {
      return `TOOL ${subtype} delete ${args.path}`;
    }

    const normalizedTool = toolName.replace(/ToolCall$/, "");
    return `TOOL ${subtype} ${normalizedTool} ${truncate(JSON.stringify(args), 120)}`;
  }

  if (type === "result") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
    const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : null;
    const isError = event.is_error === true;
    const usage = extractUsage(event);
    const spend = usage ? ` ${formatUsage(usage)}` : "";
    return `RESULT ${subtype}${isError ? " error" : ""}${durationMs ? ` durationMs=${durationMs}` : ""}${spend}`;
  }

  if (type === "turn.completed" && event.usage) {
    const usage = extractUsage(event);
    return usage ? `TURN completed ${formatUsage(usage)}` : "TURN completed";
  }

  if (type === "thinking" && event.subtype === "completed") {
    return "THINKING completed";
  }

  return null;
}

/**
 * Read spend from a stream event.
 *
 * - Claude `result`: `total_cost_usd`, `usage.{input_tokens, output_tokens,
 *   cache_read_input_tokens, cache_creation_input_tokens}`, `num_turns`.
 * - Codex `turn.completed`: `usage.{input_tokens, cached_input_tokens,
 *   output_tokens}` per turn — summed onto `previous`.
 * - Anything else: null, so the caller keeps what it had.
 */
export function extractUsage(
  event: Record<string, unknown>,
  previous?: AgentUsage,
): AgentUsage | null {
  const rawUsage =
    event.usage && typeof event.usage === "object" && !Array.isArray(event.usage)
      ? (event.usage as Record<string, unknown>)
      : undefined;
  const costUsd = numberOrUndefined(event.total_cost_usd) ?? numberOrUndefined(event.cost_usd);

  if (event.type === "result") {
    if (!rawUsage && costUsd === undefined) return null;
    return {
      reported: true,
      costUsd,
      inputTokens: numberOrUndefined(rawUsage?.input_tokens),
      outputTokens: numberOrUndefined(rawUsage?.output_tokens),
      cacheReadTokens:
        numberOrUndefined(rawUsage?.cache_read_input_tokens) ??
        numberOrUndefined(rawUsage?.cached_input_tokens),
      cacheCreationTokens: numberOrUndefined(rawUsage?.cache_creation_input_tokens),
      turns: numberOrUndefined(event.num_turns),
    };
  }

  if (event.type === "turn.completed" && rawUsage) {
    return {
      reported: true,
      costUsd: previous?.costUsd,
      inputTokens: addOptional(previous?.inputTokens, numberOrUndefined(rawUsage.input_tokens)),
      outputTokens: addOptional(previous?.outputTokens, numberOrUndefined(rawUsage.output_tokens)),
      cacheReadTokens: addOptional(
        previous?.cacheReadTokens,
        numberOrUndefined(rawUsage.cached_input_tokens) ??
          numberOrUndefined(rawUsage.cache_read_input_tokens),
      ),
      cacheCreationTokens: previous?.cacheCreationTokens,
      turns: (previous?.turns ?? 0) + 1,
    };
  }

  return null;
}

/** `$0.42 · 12.3k in / 1.8k out` — or `cost unknown` when the agent said nothing. */
export function formatUsage(usage: AgentUsage | undefined): string {
  if (!usage || !usage.reported) return "cost unknown";
  const parts: string[] = [];
  if (usage.costUsd !== undefined) parts.push(formatUsd(usage.costUsd));
  const tokens: string[] = [];
  if (usage.inputTokens !== undefined) tokens.push(`${formatTokens(usage.inputTokens)} in`);
  if (usage.outputTokens !== undefined) tokens.push(`${formatTokens(usage.outputTokens)} out`);
  if (usage.cacheReadTokens) tokens.push(`${formatTokens(usage.cacheReadTokens)} cached`);
  if (tokens.length > 0) parts.push(tokens.join(" / "));
  return parts.length > 0 ? parts.join(" · ") : "cost unknown";
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 0.1 && value > 0 ? 3 : 2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
