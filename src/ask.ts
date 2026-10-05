import { createInterface } from "node:readline/promises";

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
