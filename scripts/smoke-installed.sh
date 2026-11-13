#!/usr/bin/env bash
# smoke-installed.sh — verify the PACKED plugin artifact against an installed
# dsh CLI in an isolated throwaway profile. Beyond composition checks, it
# boots the packed plugin through dsh and executes ctx.web.search against a
# deterministic transport response.
#
# usage: scripts/smoke-installed.sh [path/to/tarball]
#   Without an argument the newest ./*.tgz in the package root is used
#   (run `npm pack` first, or pass an explicit tarball path).
#   DSH_BIN overrides the CLI binary (default: `dsh` on PATH).
# Exit 0 only if add, runtime search, dump assertions, and remove/re-add succeed.
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
SMOKE_PID=""
cleanup() {
  if [[ -n $SMOKE_PID ]] && kill -0 "$SMOKE_PID" 2>/dev/null; then
    kill -TERM "$SMOKE_PID" 2>/dev/null || true
    wait "$SMOKE_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_HOME"
}
trap cleanup EXIT
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

echo "--- configure deterministic installed search probe"
PROF_DIR="$SMOKE_HOME/profiles/$SMOKE_PROFILE"
SMOKE_RESULT="$SMOKE_HOME/search-result.json"
export DSH_WEB_SEARCH_SMOKE_RESULT="$SMOKE_RESULT"
PROBE="$SMOKE_HOME/search-probe.mjs"
cat > "$PROBE" <<'JS'
import { writeFile } from 'node:fs/promises'

export const name = 'web-search-public-installed-smoke'
export const inject = ['web']

export async function apply(ctx) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(
    '<div class="result"><a class="result__a" href="https://example.org/installed">Installed smoke</a></div>',
    { status: 200, headers: { 'content-type': 'text/html' } },
  )
  try {
    let result
    let selectionFailure
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        result = await ctx.web.search({ query: 'installed smoke', maxResults: 1 })
        break
      } catch (error) {
        if (error?.code !== 'WEB_PROVIDER_CONFIGURED_MISSING'
          && error?.code !== 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE') throw error
        selectionFailure = error
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (result === undefined) throw selectionFailure
    await writeFile(process.env.DSH_WEB_SEARCH_SMOKE_RESULT, JSON.stringify(result))
  } finally {
    globalThis.fetch = originalFetch
  }
}
JS

cat > "$PROF_DIR/cordis.patch.yml" <<YAML
- id: web
  config:
    searchProvider: public
- id: web-search-public-npm
  config:
    engines: [duckduckgo]
    softDeadlineMs: 100
    hardDeadlineMs: 1000
    maxRetries: 0
- insert:
    - id: web-search-public-installed-smoke
      name: '$PROBE'
YAML

echo "--- boot packed plugin and execute ctx.web.search"
BOOT_LOG="$SMOKE_HOME/boot.log"
"$DSH_BIN" --profile "$SMOKE_PROFILE" >"$BOOT_LOG" 2>&1 &
SMOKE_PID=$!
for _ in {1..100}; do
  [[ -f $SMOKE_RESULT ]] && break
  if ! kill -0 "$SMOKE_PID" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ ! -f $SMOKE_RESULT ]]; then
  echo "FAIL installed plugin did not execute a search" >&2
  cat "$BOOT_LOG" >&2
  exit 1
fi
node -e '
  const fs = require("node:fs")
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  if (result.sources?.[0]?.url !== "https://example.org/installed" || result.truncated !== false) {
    console.error("FAIL unexpected installed search result", result)
    process.exit(1)
  }
' "$SMOKE_RESULT"
kill -TERM "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" || true
SMOKE_PID=""
echo "OK   packed plugin booted and returned the fixture source"

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
