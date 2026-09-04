#!/usr/bin/env bash
# Verify the Claude EVALUATE path end to end with a real agent.
#
# Everything around the validator is already covered by test/browser/runtime-tiers.test.mjs.
# The one thing a fixture cannot answer is whether a real Claude session picks up
# the --mcp-config the harness hands it and actually drives Chromium.
#
# Only the validator is a real Claude session; the generator is a mock, so this
# isolates the MCP question and does not pay for a generation run.
#
# Requires: `claude` on PATH and authenticated. Consumes Claude usage.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${EVALUATE_DIR:-${TIER3_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/evaluate-claude.XXXXXX")}}"
# Outside the workspace: a log written inside it would dirty the tree and the
# run refuses to start on a dirty tree.
RUN_LOG="${EVALUATE_LOG:-${TIER3_LOG:-${WORK%/}-run.log}}"
KEEP="${EVALUATE_KEEP:-${TIER3_KEEP:-1}}"

command -v claude >/dev/null 2>&1 || { echo "FAIL: claude is not on PATH" >&2; exit 1; }

echo "==> workspace: $WORK"
mkdir -p "$WORK/.harness/validators" "$WORK/.harness/evals"
cd "$WORK"

cat > package.json <<'JSON'
{ "name": "evaluate-claude-fixture", "version": "1.0.0", "private": true }
JSON

# A page whose content can only be confirmed by actually loading it.
cat > server.mjs <<'JS'
import { createServer } from "node:http";
const server = createServer((req, res) => {
  if (req.url === "/learn") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body>
      <h1>Hedera Consensus Service</h1>
      <p id="marker">HARNESS-EVALUATE-OK</p>
      <p>This page explains how the demo submits messages to a topic.</p>
    </body></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><h1>Home</h1><p>Visit the learn page for details.</p></body></html>");
});
server.listen(0, "127.0.0.1", () => {
  console.log("Local: http://127.0.0.1:" + server.address().port);
});
JS

cat > agent.mjs <<'JS'
// Mock generator: the app is already correct, so this only has to not break it.
console.log("mock generator: no changes needed");
JS

printf 'Serve a /learn page describing the demo.\n' > .harness/prd.md
printf '{"fileAssertions":{"required":["server.mjs"]}}\n' > .harness/validators/static.json
printf '{"commands":[{"name":"install","command":"true"}]}\n' > .harness/validators/yarn.json

cat > .harness/validators/playwright-smoke.yaml <<'YAML'
name: evaluate-smoke
server:
  command: node server.mjs
  url: http://127.0.0.1:0
  timeoutMs: 60000
routes:
  - name: home
    path: /
  - name: learn
    path: /learn
YAML

# The assertion names a string only visible by loading the page, so a validator
# that cannot reach the browser has to fail it rather than guess.
cat > .harness/evals/learn.json <<'JSON'
{
  "assertions": [
    {
      "id": "E1",
      "journey": "browse",
      "route": "/learn",
      "severity": "critical",
      "statement": "The /learn page renders a heading mentioning Hedera Consensus Service and shows the marker text HARNESS-EVALUATE-OK.",
      "howToVerify": "Navigate to /learn in the browser, read the rendered page, and confirm both the heading and the marker text are visible.",
      "verifiableWithoutCredentials": true
    }
  ]
}
JSON

cat > .harness/spec.yaml <<JSON
schemaVersion: 3
name: evaluate-claude-verify
agent: claude
prd: .harness/prd.md
eval: .harness/evals/learn.json
generator:
  provider: command
  command: node
  args:
    - "$WORK/agent.mjs"
  timeoutMs: 120000
validator:
  enabled: true
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
  playwright: .harness/validators/playwright-smoke.yaml
baseline:
  commands:
    - name: install
      command: "true"
JSON

git init -q -b main .
git add -A
git -c user.email=evaluate@local -c user.name=evaluate commit -q --no-gpg-sign -m "fixture"

echo "==> running (validator is a real Claude session)"
set +e
HUSKY=0 node "$ROOT/dist/index.js" run .harness/spec.yaml 2>&1 | tee "$RUN_LOG"
RUN_EC=${PIPESTATUS[0]}
set -e

echo
echo "==> verdict"
RUN_DIR="$(ls -1d "$WORK"/.harness/runs/* 2>/dev/null | head -1)"
node --input-type=module -e '
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const runDir = process.argv[1];
const report = JSON.parse(readFileSync(path.join(runDir, "reports/report.json"), "utf8"));
const evaluation = report.evaluation;
console.log("  playwrightGate:", report.validation?.playwrightGate?.passed);
console.log("  evaluation passed:", evaluation?.passed);
console.log("  summary:", evaluation?.verdict?.summary ?? "(none)");
if (evaluation?.findings?.length) {
  for (const f of evaluation.findings) console.log("  finding:", f.message);
}
// Did the agent actually reach the browser? Tool names appear in the raw
// stream log, not the activity summary — scanning only the latter reported a
// false negative on a run that had genuinely driven Chromium.
const logs = path.join(runDir, "logs");
const validatorLogs = readdirSync(logs).filter(f => f.startsWith("validator-attempt-"));
let navigations = 0;
let sawMarker = false;
for (const f of validatorLogs) {
  const text = readFileSync(path.join(logs, f), "utf8");
  navigations += (text.match(/mcp__playwright__browser_navigate/g) || []).length;
  if (text.includes("HARNESS-EVALUATE-OK")) sawMarker = true;
}
console.log("  browser_navigate calls:", navigations);
console.log("  page marker observed:", sawMarker);

// A pass is only meaningful if the agent actually loaded the page: the marker
// exists nowhere but the rendered HTML.
const verified = navigations > 0 && sawMarker && evaluation?.passed === true;
console.log(verified
  ? "\n  MCP VERIFIED: the validator drove a real browser and read the page."
  : "\n  MCP NOT VERIFIED: see the validator log under " + logs);
process.exit(verified ? 0 : 1);
' "$RUN_DIR"

echo
echo "==> run exit=$RUN_EC; artifacts kept at $WORK (log: $RUN_LOG)"
[ "$KEEP" = "1" ] || rm -rf "$WORK"
