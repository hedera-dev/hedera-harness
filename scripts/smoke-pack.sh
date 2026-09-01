#!/usr/bin/env bash
# Pack hedera-harness and install the tarball into a temporary Yarn 3
# (node-modules linker) project, then assert the CLI binary runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js missing — run npm run build first" >&2
  exit 1
fi

SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hedera-harness-smoke.XXXXXX")"
cleanup() {
  rm -rf "$SMOKE_DIR"
  rm -f "$ROOT"/hedera-harness-*.tgz
}
trap cleanup EXIT

echo "==> npm pack"
PACK_LINE="$(npm pack --silent)"
TGZ_NAME="$(basename "$PACK_LINE")"
TGZ_PATH="$ROOT/$TGZ_NAME"
if [[ ! -f "$TGZ_PATH" ]]; then
  echo "Expected tarball at $TGZ_PATH (npm pack said: $PACK_LINE)" >&2
  exit 1
fi

echo "==> yarn 3 smoke project in $SMOKE_DIR"
cd "$SMOKE_DIR"
cat > package.json <<'EOF'
{
  "name": "hedera-harness-smoke",
  "private": true,
  "packageManager": "yarn@3.8.7"
}
EOF

# Corepack provides Yarn 3 without a global install when packageManager is set.
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare yarn@3.8.7 --activate
else
  npm install -g yarn@1.22.22 >/dev/null 2>&1 || true
  yarn set version 3.8.7
fi

yarn config set nodeLinker node-modules
yarn add "hedera-harness@file:${TGZ_PATH}"

echo "==> yarn exec hedera-harness --help"
HELP_OUT="$(yarn exec hedera-harness --help)"
echo "$HELP_OUT"

if ! grep -q "hedera-harness" <<<"$HELP_OUT"; then
  echo "Smoke failed: help output did not mention hedera-harness" >&2
  exit 1
fi

if ! grep -Eq "Usage:|run <spec>|validate" <<<"$HELP_OUT"; then
  echo "Smoke failed: help output missing expected usage lines" >&2
  exit 1
fi

# Confirm optional peers were not pulled in for a bare install.
if [[ -d node_modules/playwright ]]; then
  echo "Smoke failed: playwright should not be installed for a default gate 0–1 consumer" >&2
  exit 1
fi
if [[ -d node_modules/@hiero-ledger ]]; then
  echo "Smoke failed: @hiero-ledger/sdk should not be installed for a default gate 0–1 consumer" >&2
  exit 1
fi

# Bundled prompts and skeletons must be present next to the installed package.
PKG_DIR="$(node --input-type=module -e "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); console.log(require('path').dirname(require.resolve('hedera-harness/package.json')));")"
if [[ ! -d "$PKG_DIR/prompts" ]]; then
  echo "Smoke failed: installed package missing prompts/ at $PKG_DIR" >&2
  exit 1
fi

echo "==> smoke-pack OK ($TGZ_NAME)"
