import { createInterface } from "node:readline/promises";
import { bold, dim } from "./style.js";

/**
 * The one place readline lives. Questions go to stderr, not stdout: stdout
 * carries the run, and under `--json` a line of English in it would break
 * every consumer.
 */
export class DeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclinedError";
  }
}

/**
 * A line beside the questions. Not an event: events are rendered to stdout
 * after the fact, and this has to land between a prompt and its answer, on the
 * same stream the prompt went to.
 */
export function aside(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * A spinner for the stretches where an agent is thinking and nothing is
 * printed. A minute of silence reads as a hang, and the only honest fix is to
 * say what is being waited on.
 *
 * Stderr, like the questions it sits among, so `--json` on stdout stays clean.
 * Silent without a terminal — the frames would be a line of noise in a log.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function working(label: string): () => void {
  if (process.stderr.isTTY !== true) return () => undefined;

  const started = Date.now();
  let frame = 0;
  const paint = (): void => {
    const seconds = Math.round((Date.now() - started) / 1000);
    const elapsed = seconds < 2 ? "" : dim(` ${seconds}s`);
    process.stderr.write(`\r\x1b[2K${FRAMES[frame++ % FRAMES.length]} ${dim(label)}${elapsed}`);
  };
  paint();
  const timer = setInterval(paint, 90);
  timer.unref();

  return () => {
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K");
  };
}

/**
 * One exchange of an interview: the question, then the line to answer it on.
 * Agent and operator are told apart by weight and colour rather than by
 * reading — on a plain feed the two run together and the answers are hard to
 * find again when scrolling back.
 */
export async function interview(
  asker: Asker,
  question: string,
  round: number,
  of: number,
): Promise<string> {
  process.stderr.write(`\n${dim(`── question ${round} of ${of}`)}\n`);
  for (const line of wrapped(question, 76)) process.stderr.write(`${bold(line)}\n`);
  return (await asker.ask(`\n${dim("›")} `)).trim();
}

/** Long questions arrive as one line and wrap badly against the prompt. */
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line === "") line = word;
      else if (`${line} ${word}`.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface Asker {
  ask(question: string): Promise<string>;
  close(): void;
}

/** A series of questions on one terminal. Throws when there is none. */
export function terminal(): Asker {
  if (!process.stdin.isTTY) {
    throw new DeclinedError(
      "this needs a terminal. Re-run in one, or pass --yes to take the defaults.",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}

/**
 * A single yes/no. `assumeYes` answers without asking — scripts and CI have
 * no one to ask. `declined` is the error a "no" becomes, since what to do
 * instead depends on who was asking.
 */
export async function confirm(
  question: string,
  assumeYes: boolean,
  declined: string,
): Promise<void> {
  if (assumeYes) return;
  const asker = terminal();
  try {
    const answer = (await asker.ask(`${question} [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new DeclinedError(declined);
  } finally {
    asker.close();
  }
}
