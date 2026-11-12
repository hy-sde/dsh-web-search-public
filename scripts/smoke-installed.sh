#!/usr/bin/env bash
# smoke-installed.sh — verify the PACKED plugin artifact against an installed
# dsh CLI in an isolated throwaway profile. No source imports: this exercises
# activation, provider selection, and unload/reload exactly as a user runs it.
#
# usage: scripts/smoke-installed.sh [path/to/tarball]
#   Without an argument the newest ./*.tgz in the package root is used
#   (run `npm pack` first, or pass an explicit tarball path).
#   DSH_BIN overrides the CLI binary (default: `dsh` on PATH).
# Exit 0 only if add, dump assertions, and remove/re-add all succeed.
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TGZ="${1:-}"
if [[ -z $TGZ ]]; then
  TGZ="$(ls -t "$PKG_ROOT"/*.tgz 2>/dev/null | head -1 || true)"
fi
if [[ -z $TGZ || ! -f $TGZ ]]; then
  echo "usage: smoke-installed.sh <tarball>  (pack one first: npm pack)" >&2
  exit 2
fi
TGZ="$(cd "$(dirname "$TGZ")" && pwd)/$(basename "$TGZ")"

DSH_BIN="${DSH_BIN:-dsh}"
SMOKE_HOME="$(mktemp -d)"
SMOKE_PROFILE="smoke-installed"
trap 'rm -rf "$SMOKE_HOME"' EXIT
export DSH_HOME="$SMOKE_HOME"

dump_composed() {
  "$DSH_BIN" --profile "$SMOKE_PROFILE" --dump-config 2>&1
}

assert_composed() {
  local composed="$1"
  grep -q '^- id: web-search-public-npm$' <<<"$composed" ||
    { echo "FAIL npm plugin row web-search-public-npm not mounted" >&2; exit 1; }
  grep -q '^    searchProvider: public$' <<<"$composed" ||
    { echo "FAIL web row lost searchProvider: public" >&2; exit 1; }
  # The bundled-row disable is a no-op patch on harnesses whose base bundle
  # lacks the row (stock dsh); assert it only where the row exists (fork).
  if grep -q '^- id: web-search-public$' <<<"$composed"; then
    grep -A2 '^- id: web-search-public$' <<<"$composed" | grep -q '^  disabled: true$' ||
      { echo "FAIL bundled web-search-public row is not disabled" >&2; exit 1; }
  fi
}

echo "--- dsh CLI: $("$DSH_BIN" --version 2>&1 | head -1)"
echo "--- plugin add $TGZ"
"$DSH_BIN" plugin --profile "$SMOKE_PROFILE" add --config.dangerouslyAllowAllBuilds=true "$TGZ"

echo "--- pin searchProvider: public (documented user flow: profile patch layer)"
PROF_DIR="$SMOKE_HOME/profiles/$SMOKE_PROFILE"
cat > "$PROF_DIR/cordis.patch.yml" <<'YAML'
- id: web
  config:
    searchProvider: public
YAML

echo "--- dump-config assertions"
COMPOSED="$(dump_composed)"
assert_composed "$COMPOSED"
echo "OK   composed tree: bundled row disabled, npm row mounted, searchProvider: public"

echo "--- unload/reload"
"$DSH_BIN" plugin --profile "$SMOKE_PROFILE" remove @hy-sde-org/dsh-web-search-public
if grep -q '^- id: web-search-public-npm$' <<<"$(dump_composed)"; then
  echo "FAIL npm row still mounted after remove" >&2
  exit 1
fi
echo "OK   remove unmounts the npm row"
"$DSH_BIN" plugin --profile "$SMOKE_PROFILE" add --config.dangerouslyAllowAllBuilds=true "$TGZ"
assert_composed "$(dump_composed)"
echo "OK   re-add remounts the npm row"

echo "SMOKE PASS (installed artifact: $TGZ)"
