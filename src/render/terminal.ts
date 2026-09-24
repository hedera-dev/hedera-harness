import { relative } from "node:path";
import { describe } from "../commands.js";
import { CONFIG_FILE } from "../config.js";
import { type HarnessEvent, subscribe } from "../events.js";
import { describeFailure } from "../failure.js";
import {
  banner,
  bold,
  clip,
  describeTimings,
  dim,
  formatClock,
  frame,
  green,
  heading,
  red,
  row,
  tick,
  verdict,
  warn,
  yellow,
} from "../style.js";

/**
 * The renderer a person watches.
 *
 * All of the state is here rather than in the stages: the clock column is
 * elapsed-since-this-phase-started, which is a property of how the output is
 * laid out, not of what happened. A stage that had to track it in order to
 * report it would be formatting, which is the thing the event seam exists to
 * stop.
 */
export function renderToTerminal(): () => void {
  let phaseStartedAt = Date.now();
  let repoRoot = "";
  /** The branch the run will put you back on, so the end can say so. */
  let startedFrom = "";

  const elapsed = (): string => formatClock(Date.now() - phaseStartedAt);

  return subscribe((event: HarnessEvent) => {
    switch (event.type) {
      case "run:started": {
        repoRoot = event.repo;
        startedFrom = event.from;
        console.log(banner());
        // Read once, at a glance, to confirm the run is pointed where you think
        // it is. Labels dim, values at full strength — the values are the part
        // being checked.
        // Not "harness run": the wordmark above just said harness.
        console.log(`\n${bold(event.command)}  ${dim(event.stamp)}`);
        console.log(`${dim("repo  ")} ${event.repo}`);
        if (event.spec !== undefined) {
          console.log(`${dim("spec  ")} ${event.specInRepo ?? event.spec}`);
        }
        console.log(`${dim("from  ")} ${event.from} ${dim(`at ${event.head}`)}`);
        console.log(
          `${dim("model ")} ${event.model} ${dim(`· up to ${event.maxAttempts} attempt(s)`)}`,
        );
        return;
      }

      case "phase:started": {
        phaseStartedAt = Date.now();
        const attempt = event.attempt === undefined ? "" : `attempt ${event.attempt}`;
        const detail = [attempt, event.detail].filter((part) => part).join(" · ");
        console.log(heading(event.phase, detail));
        return;
      }

      case "check": {
        console.log(event.ok ? tick(event.name) : warn(event.name));
        if (event.remedy !== undefined) console.log(`  ${dim(event.remedy)}`);
        return;
      }

      case "command:started":
        console.log(row(event.name, describe(event.command)));
        return;

      case "command:skipped":
        console.log(row(event.name, `skipped (${event.reason})`));
        return;

      case "command:tick":
        // The row above already named the command; repeating it on every
        // heartbeat just pushes the output that actually changes further right.
        console.log(`  ${dim(formatClock(event.elapsedMs))}  ${dim(event.line || "running…")}`);
        return;

      case "tool":
        // The tool name is the only part at full strength — it is what the eye
        // scans for when skimming back through several hundred of these.
        console.log(
          `  ${dim(elapsed())}  ${event.tool.padEnd(7)} ` +
            `${dim(clip(relativise(event.argument, repoRoot)))}`,
        );
        return;

      case "generate:finished": {
        const cost = event.costUsd === undefined ? "" : `, ~$${event.costUsd.toFixed(2)} of tokens`;
        console.log(
          `  ${dim(elapsed())}  ` +
            dim(`done — ${event.turns} turns, ${event.toolCalls} tool calls${cost}`),
        );
        return;
      }

      case "evaluate:finished":
        // The verdict is the one thing in a stage that should not be toned down.
        console.log(`  ${dim(elapsed())}  ${verdict(event.verdict, event.findings)}`);
        return;

      case "check:settled": {
        // A settled claim reads as a check because that is what it is: the
        // harness looked, rather than the evaluator saying so.
        const mark = event.state === "held" ? tick("") : event.state === "failed" ? red("✗") : warn("");
        console.log(`  ${mark.trim()} ${dim(`${event.id} — ${event.detail}`)}`);
        return;
      }

      case "committed":
        console.log(
          dim(
            event.sha === null
              ? `  attempt ${event.attempt} changed nothing`
              : `  attempt ${event.attempt} committed ${event.sha.slice(0, 12)}`,
          ),
        );
        return;

      case "attempt:finished": {
        if (event.passed) {
          const resolved = event.fixed > 0 ? dim(` — ${event.fixed} fixed`) : "";
          console.log(`\nattempt ${event.attempt} ${green("PASSED")}${resolved}`);
          return;
        }
        const tally = `${event.open} open, ${event.fixed} fixed, ${event.fresh} new`;
        console.log(`\nattempt ${event.attempt} ${red("FAILED")} ${dim(`— ${tally}`)}`);
        // Findings stay at full strength: they are the reason to be reading this.
        for (const failure of event.failures) console.log(`  ${describeFailure(failure)}`);
        return;
      }

      case "proposal":
        // Not `heading(CONFIG_FILE)`: headings are uppercased, and shouting a real
        // filename back at someone misrepresents what is on disk.
        console.log(heading("proposed", `commands for this project — ${CONFIG_FILE}`));
        for (const { name, command, note } of event.commands) {
          console.log(`\n  ${name.padEnd(8)}${command === null ? dim("(none)") : describe(command)}`);
          // The agent's reasoning, which is the whole point of confirming.
          if (note !== undefined) console.log(`  ${" ".repeat(8)}${dim(note)}`);
        }
        console.log("");
        return;

      case "branch":
        console.log(dim(`\nworking on ${event.branch}`));
        return;

      case "note":
        // A warning arrives mid-feed, so it gets a blank line above it or it is
        // just another grey row in three hundred.
        console.log(event.level === "warn" ? `\n${yellow(event.text)}` : event.text);
        return;

      case "spec:written":
        console.log(
          `\n${bold(event.path)}` +
            `${event.tailored ? "" : dim("  (generic skeleton — the agent was unreachable)")}\n` +
            `${dim("fill it in, then:")}  harness run --spec ${event.path}`,
        );
        return;

      case "run:finished": {
        // The one block worth screenshotting: the verdict, where the time went,
        // and the two paths you need next — the branch holding the work and the
        // run that explains it.
        const verdict = event.cancelled
          ? yellow("CANCELLED")
          : `${event.passed ? green("PASSED") : red("FAILED")} ${dim(`after ${event.attempts} attempt(s)`)}`;
        const lines = [verdict];
        if (!event.cancelled) lines.push(dim(describeTimings(event.timings)));
        if (event.branch !== null) lines.push(`${dim("branch")} ${event.branch}`);
        lines.push(`${dim("run   ")} ${relativise(event.dir, repoRoot)}`);

        // Everything a renderer produces goes to stdout, cancellation included:
        // one stream holds the whole narrative, so `harness run > log.txt`
        // captures it all. Only a thrown error reaches stderr.
        console.log(`\n${frame(lines)}\n`);

        // A run announces "working on <branch>" when it starts and then puts
        // you back where you began. Leaving that second move unsaid is how a
        // passing run reads as a failed one: you go to look at the app, you are
        // on your own branch, and the feature is not there.
        if (event.branch !== null) {
          console.log(dim(`the work is on a branch — you are back on ${startedFrom}:`));
          console.log(`  git switch ${event.branch}\n`);
        }
        return;
      }
    }
  });
}



/**
 * Absolute paths are most of a line and none of the information — the agent
 * works in one repo, so the root is noise repeated on every row.
 */
function relativise(text: string, root: string): string {
  if (root === "") return text;
  return text.startsWith(root) ? relative(root, text) || text : text.split(`${root}/`).join("");
}

