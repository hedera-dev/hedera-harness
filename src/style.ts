import type { Timings } from "./events.js";

/**
 * Terminal styling, in the smallest form that does the job.
 *
 * Colour carries meaning, never decoration: green passed, red failed, dim is
 * context you skim past. If colour ever makes a failure harder to spot it has
 * gone too far. Plain ANSI — no dependency, no alternate screen, no repainting
 * — so piped output is byte-identical minus the escape codes.
 */
const COLOUR = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

function paint(code: number): (text: string) => string {
  return (text) => (COLOUR ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);

/** A passed check. The tick carries the colour; the text stays readable without it. */
export function tick(text: string): string {
  return `${green("✓")} ${text}`;
}

/** A check that did not pass but is not fatal — a missing skill set, a skipped stage. */
export function warn(text: string): string {
  return `${yellow("!")} ${text}`;
}

/**
 * `  build   yarn next:build` — one command in a stage, with the heartbeat
 * rows it emits indented underneath, so a stage and its output read as one
 * block. The heading above already says which attempt is running, so the row
 * carries only the command.
 */
export function row(stage: string, detail: string): string {
  return `  ${stage.padEnd(7)} ${dim(detail)}`;
}

/**
 * `verdict: fail — 2 finding(s)` — the evaluator's answer.
 *
 * Shared rather than written per renderer: it is the one line in a run that
 * must read identically whether you watched it happen or came back to it
 * afterwards, and two copies of the wording drift the first time either moves.
 */
export function verdict(outcome: "pass" | "fail" | "none", findings: number): string {
  if (outcome === "none") return yellow("no verdict");
  if (outcome === "pass") return green("verdict: pass");
  return red(`verdict: fail — ${findings} finding(s)`);
}

/** `GENERATE  attempt 1 · sonnet · 40 skills` — anchors a long scrollback. */
export function heading(label: string, detail = ""): string {
  return `\n${bold(label.toUpperCase())}${detail === "" ? "" : `  ${dim(detail)}`}`;
}

/**
 * The block at the end of a run — the one people screenshot. Widths are
 * measured on visible characters, so styled content still lines up.
 */
export function frame(lines: string[]): string {
  const width = Math.max(...lines.map(visibleWidth));
  const rule = "─".repeat(width + 2);
  // The border is furniture; only what is inside should compete for attention.
  const edge = dim("│");
  return [
    dim(`┌${rule}┐`),
    ...lines.map((line) => `${edge} ${line}${" ".repeat(width - visibleWidth(line))} ${edge}`),
    dim(`└${rule}┘`),
  ].join("\n");
}

function visibleWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/* Layout helpers. Pure, and shared by the live renderer and `harness report` —
 * a finished run has to read the same way as the run you watched. */

/** `generate 7:46 · test 0:52 · evaluate 3:28` */
export function describeTimings(timings: Timings): string {
  return [
    `generate ${formatDuration(timings.generateMs)}`,
    `test ${formatDuration(timings.testMs)}`,
    `evaluate ${formatDuration(timings.evaluateMs)}`,
  ].join(" · ");
}

/** `  0:04` — a running clock, right-aligned so rows line up. */
export function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`.padStart(5);
}

/**
 * `7:46` for anything over a minute, `0.3s` below it. A stage that really took
 * 278ms rounded to `0:00` in the summary, which reads as "did not run" rather
 * than "was instant".
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Single line, ellipsis rather than wrapping — the transcript has the full text. */
export function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= ARGUMENT_WIDTH ? flat : `${flat.slice(0, ARGUMENT_WIDTH - 1)}…`;
}

/** Width to clip a tool's argument to, so one call is always one line. */
const ARGUMENT_WIDTH = 96;

/**
 * The wordmark, printed once before a run starts. Dim rather than coloured:
 * colour means something in this output and a banner means nothing. It prints
 * when piped too, so piped output stays the terminal's minus the escape codes.
 */
export function banner(): string {
  const rows = [
    "█ █ █▀▀ █▀▄ █▀▀ █▀▄ ▄▀█   █ █ ▄▀█ █▀▄ █▄ █ █▀▀ █▀▀ █▀▀",
    "█▀█ █▀▀ █ █ █▀▀ █▀▄ █▀█   █▀█ █▀█ █▀▄ █ ▀█ █▀▀ ▀▀█ ▀▀█",
    "▀ ▀ ▀▀▀ ▀▀  ▀▀▀ ▀ ▀ ▀ ▀   ▀ ▀ ▀ ▀ ▀ ▀ ▀  ▀ ▀▀▀ ▀▀▀ ▀▀▀",
  ];
  return `\n${rows.map((row) => dim(row)).join("\n")}`;
}
