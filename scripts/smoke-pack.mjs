#!/usr/bin/env node
/**
 * Run the tarball smoke through a POSIX shell.
 *
 * The smoke itself stays in bash — it is a release check, not harness code.
 * This wrapper exists because `npm run` hands scripts to cmd.exe on Windows,
 * where the default Git install puts git.exe on PATH but not bash.exe, so
 * `bash scripts/...` dies with "not recognized" before the smoke says anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "smoke-pack.sh");

/** Where the Git for Windows installer puts bash, in the order it prefers. */
function windowsBashCandidates() {
  return [
    [process.env.ProgramFiles, "Git", "bin", "bash.exe"],
    [process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe"],
    [process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"],
  ]
    .filter(([root]) => Boolean(root))
    .map(parts => path.join(...parts));
}

function resolveBash() {
  if (process.platform !== "win32") return "bash";
  // PATH first: a developer who put bash there meant that one.
  if (spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0) return "bash";
  return windowsBashCandidates().find(candidate => existsSync(candidate));
}

const bash = resolveBash();
if (!bash) {
  console.error(
    "smoke:pack needs a POSIX shell. Install Git for Windows, or run scripts/smoke-pack.sh from Git Bash or WSL.",
  );
  process.exit(1);
}

// Forward slashes: Git Bash reads a Windows path fine, a backslash it eats.
const result = spawnSync(bash, [scriptPath.split(path.sep).join("/")], { stdio: "inherit" });
process.exit(result.status ?? 1);
