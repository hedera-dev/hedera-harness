import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type HarnessEvent, subscribe } from "../events.js";

/** Where the durable record of a run is written, inside the run's directory. */
export const EVENTS_FILE = "events.jsonl";

/**
 * One JSON object per line — a whole run, losslessly. It is this short only
 * because events carry data: a stage that puts a formatted sentence in an event
 * would turn this into the terminal output with extra steps.
 */
function render(write: (line: string) => void): () => void {
  return subscribe((event: HarnessEvent) => {
    write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  });
}

/** `--json`, for anything reading a run rather than watching it. */
export function renderToJson(): () => void {
  return render((line) => void process.stdout.write(line));
}

/**
 * `events.jsonl` in the run directory, whichever renderer is on stdout. Written
 * synchronously: the volume is small, and an interrupted run must not lose the
 * last few events to an append that never flushed.
 */
export function renderToFile(dir: string): () => void {
  const path = join(dir, EVENTS_FILE);
  return render((line) => appendFileSync(path, line));
}
