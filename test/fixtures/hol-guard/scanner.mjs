// Stand-in for `plugin-scanner`: `node scanner.mjs <fixture> scan . --format json`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [fixture, ...scannerArgs] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));

if (scannerArgs.includes("--help")) {
  process.stdout.write("usage: plugin-scanner scan [plugin_dir] [--format {text,json,markdown,sarif}]\n");
  process.exit(0);
}
if (fixture === "crash") {
  process.stderr.write("Traceback (most recent call last):\n  ModuleNotFoundError: No module named 'yaml'\n");
  process.exit(2);
}
// uvx prints install progress on stderr, never on stdout; keep stdout the report only.
process.stdout.write(readFileSync(path.join(here, fixture), "utf8"));
process.exit(0);
