import { appendFile, writeFile } from "node:fs/promises";

export interface AgentProgress {
  lastActivity: string;
  toolCallsStarted: number;
  toolCallsCompleted: number;
  sessionId?: string;
}

/**
 * One stream event decoded into the harness's own vocabulary.
 *
 * Every supported agent CLI streams JSONL, but no two agree on the shape.
 * Rather than thread the recipe's `agent:` down into the provider, each event
 * is matched on its own vocabulary — the three are disjoint, and a `generator:`
 * override wrapping a CLI still emits one of them.
 */
export interface StreamInterpretation {
  summary: string;
  toolCallsStarted?: number;
  toolCallsCompleted?: number;
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

    const interpretation = interpretStreamEvent(event);
    if (!interpretation) return;

    if (interpretation.sessionId) {
      this.progress.sessionId = interpretation.sessionId;
    }

    this.progress.toolCallsStarted += interpretation.toolCallsStarted ?? 0;
    this.progress.toolCallsCompleted += interpretation.toolCallsCompleted ?? 0;
    this.progress.lastActivity = interpretation.summary;

    await appendFile(
      this.activityLogPath,
      `${formatTimestamp()} ${interpretation.summary}\n`,
      "utf8",
    );
    console.log(`[hedera-harness:agent] ${interpretation.summary}`);
    await this.onProgress?.(this.getProgress());
  }
}

/** Decode one streamed event from any supported agent CLI. */
export function interpretStreamEvent(
  event: Record<string, unknown>,
): StreamInterpretation | null {
  return (
    interpretCodexEvent(event) ??
    interpretClaudeEvent(event) ??
    interpretCursorEvent(event) ??
    null
  );
}

/** Back-compat: the summary line alone. */
export function summarizeStreamEvent(event: Record<string, unknown>): string | null {
  return interpretStreamEvent(event)?.summary ?? null;
}

/**
 * Codex CLI (`codex exec --json`).
 *
 * Emits a thread/turn/item vocabulary: `thread.started` once, then
 * `item.started` / `item.completed` pairs carrying a typed `item`, closing with
 * `turn.completed` or `turn.failed`. Only the tool-shaped item types count as
 * tool calls — `agent_message` and `error` are narration, not work.
 */
function interpretCodexEvent(event: Record<string, unknown>): StreamInterpretation | null {
  const type = event.type;
  if (typeof type !== "string" || !isCodexEventType(type)) return null;

  if (type === "thread.started") {
    const threadId = typeof event.thread_id === "string" ? event.thread_id : undefined;
    return { summary: "SESSION started", sessionId: threadId };
  }

  if (type === "turn.started") {
    return { summary: "TURN started" };
  }

  if (type === "turn.completed") {
    const usage = event.usage;
    const tokens =
      usage && typeof usage === "object" && typeof (usage as { output_tokens?: unknown }).output_tokens === "number"
        ? ` outputTokens=${(usage as { output_tokens: number }).output_tokens}`
        : "";
    return { summary: `RESULT success${tokens}` };
  }

  if (type === "turn.failed") {
    return { summary: `RESULT failed error ${codexErrorMessage(event.error)}` };
  }

  if (type === "error") {
    return { summary: `RESULT failed error ${truncate(stringOf(event.message), 200)}` };
  }

  // item.started / item.completed
  const item = event.item;
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const itemType = typeof record.type === "string" ? record.type : "item";
  const starting = type === "item.started";
  const stage = starting ? "START" : "DONE";

  if (itemType === "agent_message") {
    if (starting) return null;
    return { summary: `MESSAGE ${truncate(stringOf(record.text), 160)}` };
  }

  if (itemType === "reasoning") {
    return starting ? null : { summary: "THINKING completed" };
  }

  if (itemType === "error") {
    return { summary: `ERROR ${truncate(stringOf(record.message), 200)}` };
  }

  const counters = starting ? { toolCallsStarted: 1 } : { toolCallsCompleted: 1 };

  if (itemType === "command_execution") {
    const exit =
      !starting && typeof record.exit_code === "number" ? ` exit=${record.exit_code}` : "";
    return {
      summary: `TOOL ${stage} shell ${truncate(stringOf(record.command), 160)}${exit}`,
      ...counters,
    };
  }

  if (itemType === "file_change") {
    return { summary: `TOOL ${stage} edit ${codexChangedPaths(record.changes)}`, ...counters };
  }

  if (itemType === "mcp_tool_call") {
    const server = stringOf(record.server);
    const tool = stringOf(record.tool);
    const failure =
      !starting && record.error && typeof record.error === "object"
        ? ` error=${truncate(stringOf((record.error as { message?: unknown }).message), 120)}`
        : "";
    return { summary: `TOOL ${stage} mcp ${server}.${tool}${failure}`, ...counters };
  }

  if (itemType === "web_search") {
    return { summary: `TOOL ${stage} search ${truncate(stringOf(record.query), 120)}`, ...counters };
  }

  return {
    summary: `TOOL ${stage} ${itemType} ${truncate(JSON.stringify(record), 120)}`,
    ...counters,
  };
}

function isCodexEventType(type: string): boolean {
  return (
    type.startsWith("thread.") ||
    type.startsWith("turn.") ||
    type === "item.started" ||
    type === "item.completed"
  );
}

function codexErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    return truncate(stringOf((error as { message?: unknown }).message), 200);
  }
  return truncate(stringOf(error), 200);
}

function codexChangedPaths(changes: unknown): string {
  if (!Array.isArray(changes)) return "(unknown)";
  const paths = changes
    .map(change =>
      change && typeof change === "object" ? stringOf((change as { path?: unknown }).path) : "",
    )
    .filter(Boolean);
  if (paths.length === 0) return "(unknown)";
  const [first, ...rest] = paths;
  return rest.length > 0 ? `${first} (+${rest.length} more)` : first;
}

/**
 * Claude Code (`claude -p --output-format stream-json`).
 *
 * Tool calls are content blocks inside `assistant` messages, and their results
 * come back as `tool_result` blocks on a synthetic `user` message — not as a
 * dedicated event type. Matching only Cursor's `tool_call` events left the
 * default agent reporting zero tool calls for an entire run.
 */
function interpretClaudeEvent(event: Record<string, unknown>): StreamInterpretation | null {
  const type = event.type;
  if (type !== "assistant" && type !== "user") return null;

  const blocks = claudeContentBlocks(event);
  if (blocks.length === 0) return null;

  const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;

  const toolUses = blocks.filter(block => block.type === "tool_use");
  if (toolUses.length > 0) {
    const names = toolUses.map(block => claudeToolSummary(block));
    return {
      summary: `TOOL START ${names.join(", ")}`,
      toolCallsStarted: toolUses.length,
      sessionId,
    };
  }

  const toolResults = blocks.filter(block => block.type === "tool_result");
  if (toolResults.length > 0) {
    const failed = toolResults.filter(block => block.is_error === true).length;
    return {
      summary: `TOOL DONE ${toolResults.length} result${toolResults.length === 1 ? "" : "s"}${
        failed > 0 ? ` (${failed} error)` : ""
      }`,
      toolCallsCompleted: toolResults.length,
      sessionId,
    };
  }

  if (type === "assistant") {
    const text = blocks
      .filter(block => block.type === "text")
      .map(block => stringOf(block.text))
      .join(" ")
      .trim();
    if (!text) return null;
    return { summary: `MESSAGE ${truncate(text, 160)}`, sessionId };
  }

  return null;
}

interface ClaudeContentBlock {
  type?: string;
  name?: unknown;
  input?: unknown;
  text?: unknown;
  is_error?: unknown;
}

function claudeContentBlocks(event: Record<string, unknown>): ClaudeContentBlock[] {
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ClaudeContentBlock => Boolean(block) && typeof block === "object",
  );
}

/** `Bash(echo hi)` reads better in a log tail than a bare tool name. */
function claudeToolSummary(block: ClaudeContentBlock): string {
  const name = stringOf(block.name) || "tool";
  const input = block.input;
  if (!input || typeof input !== "object") return name;
  const args = input as Record<string, unknown>;
  const detail =
    stringOf(args.command) ||
    stringOf(args.file_path) ||
    stringOf(args.path) ||
    stringOf(args.pattern) ||
    stringOf(args.url);
  return detail ? `${name}(${truncate(detail, 120)})` : name;
}

/**
 * Cursor CLI (`agent -p --output-format stream-json`).
 *
 * The original vocabulary this logger was written against: a dedicated
 * `tool_call` event whose payload key names the tool.
 */
function interpretCursorEvent(event: Record<string, unknown>): StreamInterpretation | null {
  const type = event.type;

  if (type === "system" && event.subtype === "init") {
    const model = typeof event.model === "string" ? event.model : "unknown-model";
    const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
    return { summary: `SESSION started model=${model}`, sessionId };
  }

  if (type === "tool_call") {
    const subtype =
      event.subtype === "started" ? "START" : event.subtype === "completed" ? "DONE" : "CALL";
    const counters =
      event.subtype === "started"
        ? { toolCallsStarted: 1 }
        : event.subtype === "completed"
          ? { toolCallsCompleted: 1 }
          : {};
    const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
    const toolCall = event.tool_call;
    if (!toolCall || typeof toolCall !== "object") {
      return { summary: `TOOL ${subtype}`, ...counters, sessionId };
    }

    const [toolName, payload] = Object.entries(toolCall as Record<string, unknown>).find(([key]) =>
      key.endsWith("ToolCall"),
    ) ?? ["tool", undefined];

    const args =
      payload && typeof payload === "object" && "args" in payload
        ? ((payload as { args?: Record<string, unknown> }).args ?? {})
        : {};

    return { summary: `TOOL ${subtype} ${cursorToolDetail(toolName, args)}`, ...counters, sessionId };
  }

  if (type === "result") {
    const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
    const durationMs = typeof event.duration_ms === "number" ? event.duration_ms : null;
    const isError = event.is_error === true;
    const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
    return {
      summary: `RESULT ${subtype}${isError ? " error" : ""}${durationMs ? ` durationMs=${durationMs}` : ""}`,
      sessionId,
    };
  }

  if (type === "thinking" && event.subtype === "completed") {
    return { summary: "THINKING completed" };
  }

  return null;
}

function cursorToolDetail(toolName: string, args: Record<string, unknown>): string {
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

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
