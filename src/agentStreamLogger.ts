import { appendFile, writeFile } from "node:fs/promises";

export interface AgentProgress {
  lastActivity: string;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  sessionId?: string;
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

    // Captured before the early return: events that carry no activity summary
    // (Claude opens a stream with `rate_limit_event`) still name the session.
    if (typeof event.session_id === "string") {
      this.progress.sessionId = event.session_id;
    }

    const summarized = summarizeStreamEvent(event);
    if (!summarized) return;

    this.progress.toolCallsStarted += summarized.toolCallsStarted ?? 0;
    this.progress.toolCallsCompleted += summarized.toolCallsCompleted ?? 0;
    this.progress.lastActivity = summarized.summary;

    await appendFile(this.activityLogPath, `${formatTimestamp()} ${summarized.summary}\n`, "utf8");
    console.log(`[hedera-harness:agent] ${summarized.summary}`);
    await this.onProgress?.(this.getProgress());
  }
}

/**
 * One activity-log line, plus how many tool calls the event opened or closed.
 *
 * The count is not always one: Claude issues parallel tool calls as several
 * `tool_use` blocks on a single `assistant` message, and returns them as
 * several `tool_result` blocks on the next `user` message.
 */
export interface StreamEventSummary {
  summary: string;
  toolCallsStarted?: number;
  toolCallsCompleted?: number;
}

/**
 * Summarize one stream-json event from either supported agent CLI.
 *
 * The two CLIs do not share a wire format, and only the `system` and `result`
 * envelopes happen to line up:
 *
 *   Cursor  one `tool_call` event per call, payload keyed `<name>ToolCall`
 *   Claude  `assistant` messages carrying `tool_use` content blocks, with
 *           results arriving as `tool_result` blocks on the next `user` message
 *
 * Returning `null` means "nothing worth logging" — the caller leaves progress
 * untouched rather than overwriting the last real activity with a blank line.
 */
export function summarizeStreamEvent(
  event: Record<string, unknown>,
): StreamEventSummary | null {
  const type = event.type;

  if (type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model : "unknown-model";
    return { summary: `SESSION started model=${model}` };
  }

  if (type === "tool_call") {
    return summarizeCursorToolCall(event);
  }

  if (type === "assistant") {
    return summarizeClaudeAssistantMessage(event);
  }

  if (type === "user") {
    return summarizeClaudeToolResults(event);
  }

  if (type === "result") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
    const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : null;
    const isError = event.is_error === true;
    return {
      summary: `RESULT ${subtype}${isError ? " error" : ""}${durationMs ? ` durationMs=${durationMs}` : ""}`,
    };
  }

  if (type === "thinking" && event.subtype === "completed") {
    return { summary: "THINKING completed" };
  }

  return null;
}

/** Cursor CLI: one event per tool call, payload keyed `<name>ToolCall`. */
function summarizeCursorToolCall(event: Record<string, unknown>): StreamEventSummary {
  const started = event.subtype === "started";
  const completed = event.subtype === "completed";
  const subtype = started ? "START" : completed ? "DONE" : "CALL";
  const counts = {
    ...(started ? { toolCallsStarted: 1 } : {}),
    ...(completed ? { toolCallsCompleted: 1 } : {}),
  };

  const toolCall = event.tool_call;
  if (!toolCall || typeof toolCall !== "object") {
    return { summary: `TOOL ${subtype}`, ...counts };
  }

  const [toolName, payload] = Object.entries(toolCall as Record<string, unknown>).find(([key]) =>
    key.endsWith("ToolCall"),
  ) ?? ["tool", undefined];

  const args =
    payload && typeof payload === "object" && "args" in payload
      ? ((payload as { args?: Record<string, unknown> }).args ?? {})
      : {};

  return { summary: `TOOL ${subtype} ${describeCursorTool(toolName, args)}`, ...counts };
}

function describeCursorTool(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "editToolCall" && typeof args.path === "string") {
    return `edit ${args.path}`;
  }

  if (toolName === "shellToolCall" || toolName === "runTerminalCommandToolCall") {
    const command = typeof args.command === "string" ? args.command : JSON.stringify(args);
    return `shell ${truncate(command, 160)}`;
  }

  if (toolName === "readToolCall" && typeof args.path === "string") {
    return `read ${args.path}`;
  }

  if (toolName === "grepToolCall" && typeof args.pattern === "string") {
    return `grep ${truncate(args.pattern, 80)}`;
  }

  if (toolName === "globToolCall" && typeof args.globPattern === "string") {
    return `glob ${args.globPattern}`;
  }

  if (toolName === "deleteToolCall" && typeof args.path === "string") {
    return `delete ${args.path}`;
  }

  return `${toolName.replace(/ToolCall$/, "")} ${truncate(JSON.stringify(args), 120)}`;
}

/**
 * Claude Code: an `assistant` message carries the turn's tool calls as content
 * blocks. A turn is either tool calls, extended thinking, or prose — prose is
 * worth logging because it is the only activity during a long non-tool stretch.
 */
function summarizeClaudeAssistantMessage(
  event: Record<string, unknown>,
): StreamEventSummary | null {
  const blocks = messageContentBlocks(event);
  if (blocks.length === 0) return null;

  const toolUses = blocks.filter(block => block.type === "tool_use");
  if (toolUses.length > 0) {
    const first = describeClaudeToolUse(toolUses[0]!);
    const rest = toolUses.length - 1;
    return {
      summary: `TOOL START ${first}${rest > 0 ? ` (+${rest} more)` : ""}`,
      toolCallsStarted: toolUses.length,
    };
  }

  if (blocks.some(block => block.type === "thinking")) {
    return { summary: "THINKING completed" };
  }

  const text = blocks
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text as string)
    .join(" ")
    .trim();

  return text ? { summary: `TEXT ${truncate(text, 160)}` } : null;
}

/** Claude Code: tool results come back as blocks on the following `user` message. */
function summarizeClaudeToolResults(
  event: Record<string, unknown>,
): StreamEventSummary | null {
  const results = messageContentBlocks(event).filter(block => block.type === "tool_result");
  if (results.length === 0) return null;

  const errors = results.filter(block => block.is_error === true).length;
  return {
    summary: `TOOL DONE ${results.length} result(s)${errors > 0 ? ` (${errors} error)` : ""}`,
    toolCallsCompleted: results.length,
  };
}

function describeClaudeToolUse(block: Record<string, unknown>): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const input =
    block.input && typeof block.input === "object"
      ? (block.input as Record<string, unknown>)
      : {};

  // Named to match the Cursor vocabulary above, so one activity log reads the
  // same whichever CLI produced it. MCP tools arrive as `mcp__<server>__<tool>`
  // and fall through to the generic branch.
  if (
    (name === "Edit" || name === "Write" || name === "Read" || name === "NotebookEdit") &&
    typeof input.file_path === "string"
  ) {
    return `${name.toLowerCase()} ${input.file_path}`;
  }

  // PowerShell is the Windows-host equivalent of the Bash tool.
  if ((name === "Bash" || name === "PowerShell") && typeof input.command === "string") {
    return `shell ${truncate(input.command, 160)}`;
  }

  if ((name === "Grep" || name === "Glob") && typeof input.pattern === "string") {
    return `${name.toLowerCase()} ${truncate(input.pattern, 80)}`;
  }

  if (name === "Task" && typeof input.description === "string") {
    return `task ${truncate(input.description, 80)}`;
  }

  return `${name} ${truncate(JSON.stringify(input), 120)}`;
}

/** Content blocks of a Claude `assistant`/`user` event, or `[]` for any other shape. */
function messageContentBlocks(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message;
  if (!message || typeof message !== "object") return [];

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  return content.filter(
    (block): block is Record<string, unknown> => Boolean(block) && typeof block === "object",
  );
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
