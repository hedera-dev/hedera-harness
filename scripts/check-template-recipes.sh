#!/usr/bin/env bash
# Check that every scaffold-hbar template recipe still loads under this harness.
#
# The recipes live in another repo, on branches that never merge, so nothing else
# notices when a schema change breaks one. This fetches each branch's .harness/
# and loads it — no app build, no install, seconds per branch.
#
#   SCAFFOLD_REPO   repo to check (default: hedera-dev/scaffold-hbar)
#   STRICT          set to 1 to fail on deprecation warnings, not just errors
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAFFOLD_REPO="${SCAFFOLD_REPO:-https://github.com/hedera-dev/scaffold-hbar.git}"
STRICT="${STRICT:-0}"
BRANCH_PREFIX="refs/heads/templates/"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/recipe-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> harness: $(node -p "require('$ROOT/package.json').version")"
echo "==> repo:    $SCAFFOLD_REPO"

BRANCHES="$(git ls-remote --heads "$SCAFFOLD_REPO" "${BRANCH_PREFIX}*" \
  | sed "s|.*${BRANCH_PREFIX}||" | sort)"

if [ -z "$BRANCHES" ]; then
  echo "FAIL: no templates/* branches found on $SCAFFOLD_REPO" >&2
  exit 1
fi

FAILED=""
WARNED=""
COUNT=0

for name in $BRANCHES; do
  COUNT=$((COUNT + 1))
  dir="$WORK/$name"
  mkdir -p "$dir"

  # Only the recipe is needed, so fetch a shallow single branch and read .harness/.
  if ! git clone --quiet --depth 1 --single-branch --branch "templates/$name" \
      --filter=blob:none --sparse "$SCAFFOLD_REPO" "$dir/repo" 2>/dev/null; then
    echo "  ✘ $name — could not clone"
    FAILED="$FAILED $name"
    continue
  fi
  git -C "$dir/repo" sparse-checkout set .harness >/dev/null 2>&1 || true

  spec="$dir/repo/.harness/spec.yaml"
  if [ ! -f "$spec" ]; then
    echo "  ✘ $name — no .harness/spec.yaml"
    FAILED="$FAILED $name"
    continue
  fi

  # The loader also writes warnings to stderr; doctor already reports them, so
  # keeping both would double-count.
  out="$(node "$ROOT/dist/index.js" doctor "$spec" --recipe-only 2>/dev/null)" || {
    echo "  ✘ $name — recipe does not load"
    printf '%s\n' "$out" | sed 's/^/      /'
    FAILED="$FAILED $name"
    continue
  }

  if printf '%s' "$out" | grep -q "warning(s)"; then
    detail="$(printf '%s' "$out" | grep -E 'deprecated|is ignored|unknown key' | sed 's/^ *//' | sort -u)"
    echo "  ! $name — loads with $(printf '%s\n' "$detail" | wc -l | tr -d ' ') warning(s)"
    printf '%s\n' "$detail" | sed 's/^/      /' 
    WARNED="$WARNED $name"
  else
    echo "  ✔ $name"
  fi
done

echo
echo "==> $COUNT template(s) checked"

if [ -n "$FAILED" ]; then
  echo "FAIL: recipes that do not load:$FAILED" >&2
  exit 1
fi

if [ -n "$WARNED" ]; then
  echo "Deprecation warnings on:$WARNED"
  if [ "$STRICT" = "1" ]; then
    echo "FAIL: STRICT=1 and warnings are present." >&2
    exit 1
  fi
fi

echo "==> all template recipes load"
