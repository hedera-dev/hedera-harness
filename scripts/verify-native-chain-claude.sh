#!/usr/bin/env bash
# End-to-end native CHAIN proof against scaffold-hbar hedera-demo.
# Provisions a disposable signer, has Claude add a server-signed HCS flow,
# drives it in Chromium, then proves the tx on Mirror Node.
# Requires Claude auth + funded HEDERA_OPERATOR_* (consumes usage/HBAR).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAFFOLD_REPO="${SCAFFOLD_HBAR_REPO:-$(cd "$ROOT/.." && pwd)/scaffold-hbar}"
WORK="${NATIVE_CHAIN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/native-chain-claude.XXXXXX")}"
RUN_LOG="${NATIVE_CHAIN_LOG:-${WORK%/}-run.log}"
KEEP="${NATIVE_CHAIN_KEEP:-1}"
SEED_REPO="${WORK%/}-seed.git"

command -v claude >/dev/null 2>&1 || { echo "FAIL: claude is not on PATH" >&2; exit 1; }
claude auth status >/dev/null 2>&1 || { echo "FAIL: claude is not authenticated" >&2; exit 1; }
[ -n "${HEDERA_OPERATOR_ID:-}" ] || { echo "FAIL: HEDERA_OPERATOR_ID is not set" >&2; exit 1; }
[ -n "${HEDERA_OPERATOR_KEY:-}" ] || { echo "FAIL: HEDERA_OPERATOR_KEY is not set" >&2; exit 1; }
[ -d "$SCAFFOLD_REPO/.git" ] || {
  echo "FAIL: scaffold-hbar checkout not found at $SCAFFOLD_REPO" >&2
  echo "Set SCAFFOLD_HBAR_REPO to its absolute path." >&2
  exit 1
}
[ ! -e "$WORK" ] || [ -z "$(ls -A "$WORK" 2>/dev/null)" ] || {
  echo "FAIL: proof workspace is not empty: $WORK" >&2
  exit 1
}

echo "==> building harness"
cd "$ROOT"
npm run build

# A normal scaffold-hbar checkout stores template branches as origin/* remote
# refs. Build a disposable local seed repo that exposes the selected template
# as a cloneable branch, without modifying the user's checkout.
echo "==> preparing local hedera-demo seed"
rm -rf "$SEED_REPO"
git init -q --bare "$SEED_REPO"
if git -C "$SCAFFOLD_REPO" show-ref --verify --quiet refs/heads/templates/hedera-demo; then
  TEMPLATE_SOURCE_REF="refs/heads/templates/hedera-demo"
elif git -C "$SCAFFOLD_REPO" show-ref --verify --quiet refs/remotes/origin/templates/hedera-demo; then
  TEMPLATE_SOURCE_REF="refs/remotes/origin/templates/hedera-demo"
else
  echo "FAIL: templates/hedera-demo is not available in $SCAFFOLD_REPO" >&2
  echo "Fetch that branch in scaffold-hbar, then retry." >&2
  exit 1
fi
git --git-dir="$SEED_REPO" fetch -q "$SCAFFOLD_REPO" \
  "$TEMPLATE_SOURCE_REF:refs/heads/templates/hedera-demo"

echo "==> seeding scaffold-hbar hedera-demo at $WORK"
node "$ROOT/dist/index.js" init "$WORK" \
  --repo "$SEED_REPO" \
  --template hedera-demo
rm -rf "$SEED_REPO"

mkdir -p "$WORK/.harness/validators" "$WORK/.harness/evals"

cat > "$WORK/.harness/prd.md" <<'MARKDOWN'
# Native CHAIN proof

Add a `/native-chain-proof` page to this Next.js application.

The page must have a button that calls a new server-side POST route. The route
must use `@hiero-ledger/sdk` and the existing server Hedera client to create an
HCS topic on testnet. Give the topic a short memo identifying it as a Hedera
Harness native CHAIN proof. Wait for the receipt, then return the successful
transaction ID and topic ID as JSON. Render both values on the page after a
successful click and render a useful error on failure.

Credentials must only come from the server process environment through
`HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_PRIVATE_KEY`. Never create or modify
an `.env` file, never send a private key to the browser, and never hard-code a
credential. Reuse `packages/nextjs/services/hederaClient.ts`.

Keep the implementation focused. Preserve the existing hedera-demo behavior.
MARKDOWN

cat > "$WORK/.harness/evals/native-chain.json" <<'JSON'
{
  "assertions": [
    {
      "id": "CHAIN-UI",
      "journey": "native-chain",
      "route": "/native-chain-proof",
      "severity": "critical",
      "statement": "The page explains that it creates an HCS topic using a server-side disposable signer and provides a control to run the proof.",
      "howToVerify": "Open /native-chain-proof and inspect the rendered page.",
      "verifiableWithoutCredentials": true
    },
    {
      "id": "CHAIN-TX",
      "journey": "native-chain",
      "route": "/native-chain-proof",
      "severity": "critical",
      "statement": "Activating the proof control creates an HCS topic and the page renders both a successful transaction ID and topic ID.",
      "howToVerify": "Open /native-chain-proof, activate the proof control once, wait for Hedera consensus, and confirm both IDs are rendered.",
      "verifiableWithoutCredentials": false
    }
  ]
}
JSON

cat > "$WORK/.harness/validators/static.json" <<'JSON'
{
  "name": "native-chain-static",
  "fileAssertions": {
    "required": [
      "packages/nextjs/app/native-chain-proof/page.tsx",
      "packages/nextjs/app/api/hedera/native-chain-proof/route.ts"
    ],
    "forbidden": [
      ".env",
      "packages/nextjs/.env"
    ]
  },
  "textAssertions": [
    {
      "file": "packages/nextjs/app/api/hedera/native-chain-proof/route.ts",
      "contains": ["TopicCreateTransaction", "getReceipt"]
    }
  ]
}
JSON

cat > "$WORK/.harness/validators/yarn.json" <<'JSON'
{
  "name": "native-chain-yarn",
  "requiresNoSecrets": true,
  "commands": [
    {
      "name": "install",
      "command": "yarn install",
      "timeoutMs": 300000
    },
    {
      "name": "check-types",
      "command": "yarn next:check-types",
      "timeoutMs": 300000
    },
    {
      "name": "build",
      "command": "yarn next:build",
      "timeoutMs": 300000
    }
  ]
}
JSON

cat > "$WORK/.harness/validators/playwright-smoke.yaml" <<'YAML'
name: native-chain-smoke
server:
  command: yarn next:dev
  url: http://127.0.0.1:0
  timeoutMs: 120000
routes:
  - name: native-chain-proof
    path: /native-chain-proof
YAML

cat > "$WORK/.harness/spec.yaml" <<'YAML'
schemaVersion: 3
name: native-chain-proof
description: Prove server-side native Hedera signing and harness-owned Mirror Node verification.
agent: claude
prd: .harness/prd.md
eval: .harness/evals/native-chain.json
maxAttempts: 3
baseline:
  commands:
    - name: install
      command: yarn install
      timeoutMs: 300000
    - name: build
      command: yarn next:build
      timeoutMs: 300000
validators:
  static: .harness/validators/static.json
  commands: .harness/validators/yarn.json
  playwright: .harness/validators/playwright-smoke.yaml
validator:
  enabled: true
chainValidation:
  enabled: true
  network: testnet
  operator:
    accountIdEnv: HEDERA_OPERATOR_ID
    privateKeyEnv: HEDERA_OPERATOR_KEY
  fundingHbar: 2
  sweepBack: true
  expose:
    appEnv:
      HEDERA_OPERATOR_ID: accountId
      HEDERA_OPERATOR_PRIVATE_KEY: privateKey
  verify:
    transactionTypes:
      - CONSENSUSCREATETOPIC
    timeoutMs: 60000
YAML

cd "$WORK"
git add .harness
git -c user.email=proof@local -c user.name=proof commit -q --no-gpg-sign -m "Configure native CHAIN proof"

echo "==> running generator, browser evaluation, and Mirror Node verification"
set +e
HUSKY=0 node "$ROOT/dist/index.js" run .harness/spec.yaml 2>&1 | tee "$RUN_LOG"
RUN_EC=${PIPESTATUS[0]}
set -e

echo
echo "==> proof summary"
RUN_DIR="$(ls -1dt "$WORK"/.harness/runs/* 2>/dev/null | awk 'NR == 1 { print; exit }')"
if [ -z "$RUN_DIR" ]; then
  echo "FAIL: no run artifacts found (run exit=$RUN_EC)" >&2
  exit 1
fi

node --input-type=module - "$RUN_DIR" "$RUN_EC" <<'JS'
import { readFileSync } from "node:fs";
import path from "node:path";

const runDir = process.argv[2];
const runExit = Number(process.argv[3]);
const report = JSON.parse(readFileSync(path.join(runDir, "reports/report.json"), "utf8"));
const chain = report.evaluation?.chainVerification;

console.log("  run exit:", runExit);
console.log("  deterministic validation:", report.validation?.passed);
console.log("  browser evaluation:", report.evaluation?.passed);
console.log("  chain verification:", chain?.passed);
for (const proof of chain?.proofs ?? []) {
  console.log(`  ${proof.transactionType}: ${proof.transactionId} @ ${proof.consensusTimestamp}`);
}
for (const finding of chain?.findings ?? []) {
  console.log(`  finding [${finding.category}]: ${finding.message}`);
}

const verified =
  runExit === 0 &&
  report.validation?.passed === true &&
  report.evaluation?.passed === true &&
  chain?.passed === true &&
  (chain?.proofs ?? []).some(proof => proof.transactionType === "CONSENSUSCREATETOPIC");

console.log(verified
  ? "\n  NATIVE CHAIN VERIFIED: the disposable server signer created an HCS topic and Mirror Node independently proved it."
  : "\n  NATIVE CHAIN NOT VERIFIED: inspect the run report and logs.");
process.exit(verified ? 0 : 1);
JS

echo
echo "==> artifacts kept at $WORK (log: $RUN_LOG)"
[ "$KEEP" = "1" ] || rm -rf "$WORK"
