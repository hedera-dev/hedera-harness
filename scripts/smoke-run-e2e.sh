#!/usr/bin/env bash
# Cross-repo pilot smoke:
#   pack harness tarball → scaffold hedera-demo via create-scaffold-hbar (local template)
#   → run (fail) → continue (pass) → hygiene checks
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK_ROOT="$(cd "$ROOT/.." && pwd)"
HARNESS_ROOT="$ROOT"
CREATE_ROOT="$WORK_ROOT/create-hbar"
TEMPLATE_ROOT="$WORK_ROOT/scaffold-hbar"
MOCK_AGENT="$HARNESS_ROOT/scripts/mock-agent.mjs"
# Derive from package.json: hardcoding this broke the script at the 1.1.2 bump.
HARNESS_VERSION="$(node -p "require('$HARNESS_ROOT/package.json').version")"

SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/hedera-run-e2e.XXXXXX")"
TGZ_PATH=""
cleanup() {
  # Preserve the workspace when the run failed, so the failure can be inspected.
  if [[ "${HARNESS_E2E_KEEP:-0}" == "1" ]]; then
    echo "==> keeping smoke dir: $SMOKE_DIR"
  else
    rm -rf "$SMOKE_DIR"
  fi
  rm -f "$HARNESS_ROOT"/hedera-harness-*.tgz 2>/dev/null || true
  # TGZ_PATH lives under SMOKE_DIR and is removed with it.
}
trap cleanup EXIT

echo "==> smoke dir: $SMOKE_DIR"

echo "==> build hedera-harness"
cd "$HARNESS_ROOT"
npm run build --silent

echo "==> npm pack hedera-harness"
PACK_LINE="$(npm pack --silent)"
PACKED="$HARNESS_ROOT/$(basename "$PACK_LINE")"
test -f "$PACKED"
# Yarn caches file: dependencies by locator. The name and version never change
# between runs, so a stable path made yarn reuse a stale cached zip and silently
# install an older build — the e2e then validated code that was not under test.
# A unique path per run forces a real fetch.
TGZ_PATH="$SMOKE_DIR/hedera-harness-$(date +%s)-$$.tgz"
cp "$PACKED" "$TGZ_PATH"
echo "    tarball=$TGZ_PATH"

echo "==> build create-scaffold-hbar"
cd "$CREATE_ROOT"
yarn build

echo "==> prepare local template mirror (includes uncommitted .harness recipe)"
TEMPLATE_MIRROR="$SMOKE_DIR/template-mirror"
mkdir -p "$TEMPLATE_MIRROR"
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.yarn/cache' \
  --exclude 'docs' \
  --exclude '.env' \
  --exclude 'packages/nextjs/.env' \
  --exclude '.next' \
  --exclude 'packages/nextjs/.next' \
  "$TEMPLATE_ROOT/" "$TEMPLATE_MIRROR/"
# Belts-and-suspenders: secrets must never enter the scaffolded app.
rm -f "$TEMPLATE_MIRROR/.env" "$TEMPLATE_MIRROR/packages/nextjs/.env"
test -f "$TEMPLATE_MIRROR/.harness/spec.yaml"

echo "==> scaffold hedera-demo via create-scaffold-hbar (local template seam)"
APP_DIR="$SMOKE_DIR/demo-app"
cd "$SMOKE_DIR"
CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR="$TEMPLATE_MIRROR" \
  node "$CREATE_ROOT/bin/create-scaffold-hbar.js" demo-app \
  --template hedera-demo \
  --frontend nextjs-app \
  --solidity-framework none \
  --package-manager yarn \
  --skip-install \
  --skip-hedera-skills \
  --yes

test -d "$APP_DIR"
cd "$APP_DIR"

echo "==> assert scaffold artifacts"
test -f .harness/spec.yaml
test -f .harness/prd.md
test -f .harness/validators/static.json
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const raw = readFileSync("package.json", "utf8");
const pkg = JSON.parse(raw);
const wanted = "hedera-harness run .harness/spec.yaml";
// Only rewrite when something actually changes. The scaffolded package.json has
// no trailing newline, so an unconditional write dirties the tree by one byte
// and trips the clean-tree assertion below.
if (pkg.scripts?.["harness:run"] !== wanted || pkg.scripts?.["harness:extend"]) {
  pkg.scripts = { ...(pkg.scripts || {}), "harness:run": wanted };
  delete pkg.scripts["harness:extend"];
  writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  console.log("    added harness:run script");
}
const pin = pkg.devDependencies?.["hedera-harness"];
// The template pins whatever scaffold-hbar ships; the smoke overrides it below.
if (!pin) throw new Error("template did not pin hedera-harness at all");
console.log("    template pins hedera-harness@" + pin);
'
BRANCH="$(git branch --show-current)"
test "$BRANCH" = "main"
test -z "$(git status --porcelain)"
echo "    branch=$BRANCH; clean; template.json=$(test -f template.json && echo present || echo removed-by-scaffold)"

echo "==> yarn install with local hedera-harness tarball (keep pin 1.1.0 via resolutions)"
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
yarn config set nodeLinker node-modules >/dev/null
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const [tgz, version] = process.argv.slice(1);
const pkg = JSON.parse(readFileSync("package.json","utf8"));
pkg.devDependencies = { ...pkg.devDependencies, "hedera-harness": version };
pkg.resolutions = { ...(pkg.resolutions || {}), "hedera-harness": `file:${tgz}` };
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$TGZ_PATH" "$HARNESS_VERSION"
yarn install
test -f node_modules/hedera-harness/package.json
node --input-type=module -e '
import { readFileSync } from "node:fs";
const version = process.argv[1];
const pkg = JSON.parse(readFileSync("package.json","utf8"));
if (pkg.devDependencies["hedera-harness"] !== version) throw new Error("pin lost");
const installed = JSON.parse(readFileSync("node_modules/hedera-harness/package.json","utf8"));
if (installed.version !== version) throw new Error("installed version " + installed.version);
// Version alone cannot distinguish a fresh build from a stale cached one: both
// report the same number. Assert against the source tree instead.
const { readdirSync } = await import("node:fs");
const shipped = new Set(readdirSync("node_modules/hedera-harness/dist"));
const expected = process.argv[2].split(",").filter(Boolean);
const missing = expected.filter((f) => !shipped.has(f));
if (missing.length) {
  throw new Error("installed build is stale; missing " + missing.join(", "));
}
console.log("    installed hedera-harness@" + installed.version + " (" + shipped.size + " dist files)");
' "$HARNESS_VERSION" "$(ls "$HARNESS_ROOT/dist" | tr '\n' ',')"

git add -A
if ! git diff --cached --quiet; then
  git -c user.email=smoke@example.com -c user.name=Smoke \
    commit --no-gpg-sign -m "chore: install deps + hedera-harness tarball for smoke"
fi
test -z "$(git status --porcelain)"
MAIN_SHA="$(git rev-parse HEAD)"
echo "    main@$MAIN_SHA"

echo "==> patch recipe for mock agent + fast baseline/commands"
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const mock = process.argv[1];
let spec = readFileSync(".harness/spec.yaml", "utf8");
const genStart = spec.indexOf("\ngenerator:");
const skillsIdx = spec.indexOf("\nskills:");
if (genStart < 0 || skillsIdx < 0) throw new Error("spec missing generator/skills");
const genBlock = `
generator:
  provider: command
  command: node
  args:
    - ${JSON.stringify(mock)}
  timeoutMs: 60000
`;
spec = spec.slice(0, genStart) + genBlock + spec.slice(skillsIdx);
spec = spec.replace(/\nskills:\n(?:  - .+\n)+/, "\nskills: []\n");
spec = spec.replace(
  /\nextend:\n  baseline:\n    commands:\n(?:      -[\s\S]*?\n)(?=\nvalidators:)/,
  `
extend:
  baseline:
    commands:
      - name: install
        command: "true"
        timeoutMs: 10000

`,
);
writeFileSync(".harness/spec.yaml", spec);
writeFileSync(
  ".harness/validators/yarn.json",
  JSON.stringify(
    {
      name: "hedera-demo-run-yarn-smoke",
      description: "Fast smoke commands; static validators enforce the Learn page.",
      requiresNoSecrets: true,
      forbiddenCommands: ["npm install", "npm run", "pnpm install", "pnpm run"],
      commands: [
        {
          name: "install",
          command: "true",
          timeoutMs: 10000,
          purpose: "Smoke skip real install",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log("    patched generator ->", mock);
' "$MOCK_AGENT"

git add .harness/spec.yaml .harness/validators/yarn.json
git -c user.email=smoke@example.com -c user.name=Smoke \
  commit --no-gpg-sign -m "chore: smoke mock generator and fast validators"
MAIN_SHA="$(git rev-parse HEAD)"

echo "==> run #1 (expect FAIL + checkpoint)"
# Husky pre-commit (lint-staged/typecheck) is consumer-local and can fail on template
# drift; smoke verifies harness checkpoint/continue mechanics with hooks disabled.
export HUSKY=0
export MOCK_HARNESS_MODE=fail
export MOCK_HARNESS_WORKSPACE="$APP_DIR"
rm -f .env packages/nextjs/.env
# Captured outside the app dir: a log inside it would dirty the tree and break
# the clean-tree assertions below.
RUN1_LOG="${HARNESS_E2E_RUN1_LOG:-$SMOKE_DIR/run1.log}"
set +e
yarn harness:run 2>&1 | tee "$RUN1_LOG"
RUN1_EC=${PIPESTATUS[0]}
set -e
echo "    run#1 exit=$RUN1_EC"
test "$RUN1_EC" -ne 0

# The scaffolded recipe is still schema v1 (extend.baseline, logging). Backward
# compatibility is load-bearing until every template branch is regenerated, so
# assert the deprecation path is actually taken rather than silently skipped.
if ! grep -qF 'extend.baseline` is deprecated' "$RUN1_LOG"; then
  echo "FAIL: legacy recipe did not emit the extend.baseline deprecation warning" >&2
  echo "      (either the warning regressed, or the recipe is no longer v1)" >&2
  exit 1
fi
if ! grep -qF '`logging` is ignored' "$RUN1_LOG"; then
  echo "FAIL: legacy recipe did not warn that logging is ignored" >&2
  exit 1
fi
echo "    schema v1 deprecation warnings present"

EXT_BRANCH="$(git branch --show-current)"
echo "    branch=$EXT_BRANCH"
[[ "$EXT_BRANCH" == harness/run-* ]]
test "$(git rev-parse main)" = "$MAIN_SHA"
# Drop any hook-stash leftovers so continue isn't blocked as interrupted-dirty.
git reset --hard HEAD >/dev/null
git clean -fd >/dev/null
test -z "$(git status --porcelain)"
COMMITS_AFTER_1="$(git rev-list --count main..HEAD)"
echo "    commits ahead of main: $COMMITS_AFTER_1"
test "$COMMITS_AFTER_1" -ge 1
RUN_DIR="$(ls -1d .harness/runs/* | head -1)"
test -f "$RUN_DIR/session.json"
test -f "$RUN_DIR/reports/report.json"

if git ls-tree -r HEAD --name-only | grep -E '^\.harness/(runs|cache|runtime)/|^\.harness-skills/|^\.skill-cache/' >/dev/null; then
  echo "FAIL: runtime paths committed" >&2
  exit 1
fi

echo "==> run #2 continue same branch (expect PASS)"
export HUSKY=0
export MOCK_HARNESS_MODE=pass
PREV_BRANCH="$EXT_BRANCH"
set +e
yarn harness:run
RUN2_EC=$?
set -e
echo "    run#2 exit=$RUN2_EC"
test "$RUN2_EC" -eq 0

EXT_BRANCH2="$(git branch --show-current)"
test "$EXT_BRANCH2" = "$PREV_BRANCH"
test "$(git rev-parse main)" = "$MAIN_SHA"
NESTED_COUNT="$(git branch --list 'harness/run-*' | wc -l | tr -d ' ')"
test "$NESTED_COUNT" -eq 1
test -z "$(git status --porcelain)"

echo "==> hygiene: branch diff vs main"
DIFF_FILES="$(git diff --name-only main...HEAD)"
echo "$DIFF_FILES"
echo "$DIFF_FILES" | grep -q 'packages/nextjs/app/learn/page.tsx'
echo "$DIFF_FILES" | grep -q 'packages/nextjs/components/Header.tsx'
if echo "$DIFF_FILES" | grep -E '^\.harness/(runs|cache|runtime)/|^\.cursor/mcp\.json$|^\.env$|node_modules/|^\.harness-skills/' >/dev/null; then
  echo "FAIL: dirty runtime/secret paths in branch diff" >&2
  exit 1
fi
grep -q 'How this demo uses Hedera' packages/nextjs/app/learn/page.tsx
grep -q '/learn' packages/nextjs/components/Header.tsx

LATEST_SESSION="$(ls -1td .harness/runs/*/session.json | head -1)"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const session = JSON.parse(readFileSync(process.argv[1], "utf8"));
if (session.gateStatus !== "passed") throw new Error("expected gateStatus=passed, got " + session.gateStatus);
console.log("    final session gateStatus=" + session.gateStatus + " cycle=" + session.cycle + " branch=" + session.branch);
' "$LATEST_SESSION"

echo "==> smoke-run-e2e OK"
echo "    main untouched @ $MAIN_SHA"
echo "    harness branch $EXT_BRANCH2"
echo "    runtime ignored; no nested branch; continue worked"
