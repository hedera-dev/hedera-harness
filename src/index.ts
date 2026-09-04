#!/usr/bin/env node
import { parseCliArgs, printHelp, runCli } from "./cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const parsed = parseCliArgs(args);
  await runCli(parsed);
}

main()
  .then(() => {
    // Force exit so leftover agent/dev-server handles cannot hang the CLI after
    // results are printed (see DevServerSession.stop process-group teardown).
    process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  });
