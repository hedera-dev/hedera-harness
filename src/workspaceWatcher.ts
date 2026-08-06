import { appendFile, writeFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "artifacts",
  "cache",
  ".harness-skills",
  ".harness-context",
  ".skill-cache",
]);

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private changes = 0;

  constructor(
    private readonly workspacePath: string,
    private readonly activityLogPath: string,
    private readonly onChange?: (summary: string) => void | Promise<void>,
  ) {}

  async start(): Promise<void> {
    await writeFile(
      this.activityLogPath,
      ["# workspace activity log", "# file changes while the generator agent is running", ""].join("\n"),
      "utf8",
    );

    this.watcher = watch(this.workspacePath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      void this.recordChange(filename);
    });
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    await appendFile(
      this.activityLogPath,
      `${new Date().toISOString()} WATCHER stopped totalChanges=${this.changes}\n`,
      "utf8",
    );
  }

  private async recordChange(filename: string): Promise<void> {
    if (shouldIgnoreWorkspaceActivity(filename)) {
      return;
    }

    this.changes += 1;
    const summary = `FILE ${filename}`;
    await appendFile(this.activityLogPath, `${new Date().toISOString()} ${summary}\n`, "utf8");

    if (this.changes <= 20 || this.changes % 25 === 0) {
      console.log(`[hedera-harness:workspace] ${summary}`);
    }

    await this.onChange?.(summary);
  }
}

export function shouldIgnoreWorkspaceActivity(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  if (
    normalized === ".harness" ||
    normalized.startsWith(".harness/") ||
    normalized.includes("/.harness/")
  ) {
    return true;
  }
  const segments = normalized.split("/");
  return segments.some(segment => IGNORED_SEGMENTS.has(segment));
}
