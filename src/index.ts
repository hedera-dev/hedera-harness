#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseCliArgs, printHelp, runCli } from "./cli.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  if (args.includes("--version") || args.includes("-v")) {
    // Handled here rather than in parseCliArgs, which only knows subcommands
    // and answers a bare flag with `Expected command "init", "run", ...`.
    // dist/index.js sits one level under the package root in a checkout and in
    // an installed copy alike, and package.json ships in both.
    const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
    console.log(pkg.version);
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
