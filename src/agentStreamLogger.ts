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
    return `RESULT ${subtype}${isError ? " error" : ""}${durationMs ? ` durationMs=${durationMs}` : ""}`;
  }

  if (type === "thinking" && event.subtype === "completed") {
    return "THINKING completed";
  }

  return null;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}
