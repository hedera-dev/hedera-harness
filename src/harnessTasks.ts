import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  hardhatGate,
  inferContractScope,
  parseContractScopeLine,
  type ContractScope,
} from "./contractScope.js";
import { inspectWorkspacePrd } from "./prdStatus.js";

export const TASKS_FILE = ".harness/tasks.md";

export interface HarnessTask {
  id: string;
  text: string;
  done: boolean;
}

export interface TasksStatus {
  file: string;
  exists: boolean;
  tasks: HarnessTask[];
  pending: HarnessTask[];
  next?: HarnessTask;
  contracts: ContractScope;
}

const TASK_LINE = /^- \[([ xX])\]\s+(T\d+):\s+(.+?)\s*$/;

export function tasksFilePath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), TASKS_FILE);
}

export function parseTasksMarkdown(markdown: string): HarnessTask[] {
  const tasks: HarnessTask[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(TASK_LINE);
    if (!match) continue;
    tasks.push({
      id: match[2],
      text: match[3].trim(),
      done: match[1] !== " ",
    });
  }
  return tasks;
}

export function inspectTasks(workspaceDir: string): TasksStatus {
  const file = tasksFilePath(workspaceDir);
  const contracts = resolveContractScope(workspaceDir);
  if (!existsSync(file)) {
    return { file, exists: false, tasks: [], pending: [], contracts };
  }
  const tasks = parseTasksMarkdown(readFileSync(file, "utf8"));
  const pending = tasks.filter(task => !task.done);
  return { file, exists: true, tasks, pending, next: pending[0], contracts };
}

export function formatTasksStatus(status: TasksStatus): string {
  const gate = hardhatGate(status.contracts);
  const scopeLines = [
    `contracts=${status.contracts}`,
    `hardhat=${gate}`,
    `assert=${gate === "skip" ? "next-only" : "next+hardhat"}`,
  ];
  if (!status.exists) {
    return [
      "file=missing",
      "pending=0",
      "all_done=false",
      ...scopeLines,
      "hint=No .harness/tasks.md — spawn one hedera-generate for the whole PRD.",
    ].join("\n");
  }
  const next = status.next;
  return [
    `file=${TASKS_FILE}`,
    `total=${status.tasks.length}`,
    `pending=${status.pending.length}`,
    `all_done=${status.pending.length === 0}`,
    next ? `next=${next.id}` : "next=",
    next ? `next_text=${next.text}` : undefined,
    ...scopeLines,
    gate === "skip"
      ? "hint=ASSERT: yarn next:lint only (no next:build). SMOKE/E2E use next:dev. Do not run root yarn lint or yarn hardhat:*. GENERATE must not edit packages/hardhat or packages/foundry."
      : "hint=ASSERT: include yarn hardhat:compile (and forge if Foundry is in the PRD).",
    ...status.tasks.map(task => `${task.done ? "done" : "todo"}=${task.id} ${task.text}`),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function resolveContractScope(workspaceDir: string): ContractScope {
  const file = tasksFilePath(workspaceDir);
  if (existsSync(file)) {
    const fromTasks = parseContractScopeLine(readFileSync(file, "utf8"));
    if (fromTasks) return fromTasks;
  }
  const prd = inspectWorkspacePrd(workspaceDir);
  if (prd.kind === "real" && prd.path) {
    const abs = path.resolve(workspaceDir, prd.path);
    if (existsSync(abs)) return inferContractScope(readFileSync(abs, "utf8"));
  }
  return "none";
}

export function markTaskDone(workspaceDir: string, taskId: string): TasksStatus {
  const file = tasksFilePath(workspaceDir);
  if (!existsSync(file)) {
    throw new Error("No .harness/tasks.md to mark done.");
  }
  const original = readFileSync(file, "utf8");
  const updated = original
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(TASK_LINE);
      if (!match || match[2] !== taskId) return line;
      return `- [x] ${match[2]}: ${match[3].trim()}`;
    })
    .join("\n");
  if (!parseTasksMarkdown(original).some(task => task.id === taskId)) {
    throw new Error(`Task ${taskId} not found in .harness/tasks.md.`);
  }
  if (updated !== original) {
    writeFileSync(file, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
  }
  return inspectTasks(workspaceDir);
}
