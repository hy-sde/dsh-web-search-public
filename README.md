<!-- MIRROR-NOTE:START -->
> [!NOTE]
> 📦 This plugin lives in the [**dsh-plugins**](https://github.com/hy-sde/dsh-plugins) monorepo — file issues & pull requests there.
> npm: [`@hy-sde-org/dsh-web-search-public`](https://www.npmjs.com/package/@hy-sde-org/dsh-web-search-public)
<!-- MIRROR-NOTE:END -->

# dsh-web-search-public — credential-free web search for DeepSeek Harness

A zero-API-key web search provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
With a single `web_search` call it **fans the query out to all five public engines in
parallel — Startpage, DuckDuckGo, Ecosia, Google, Mojeek** — and consolidates the answers by
cross-engine consensus, so no single engine's bot challenge, timeout, or empty page can
degrade the search. No API keys, no accounts, no fetch provider, no setup.

| Identity | Value |
| --- | --- |
| Package | `@hy-sde-org/dsh-web-search-public` |
| Plugin id | `web-search-public` |
| Provider id | `public` |
| Engines (fanned out) | `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek` |
> **Based on [oh-my-pi](https://github.com/can1357/oh-my-pi)** — the credential-free engine
> scrapers are ported from oh-my-pi’s `web/search/providers`, and the provider is a faithful
> port of oh-my-pi’s parallel `searchPublicWeb` aggregate (fan-out, soft/hard deadlines,
> consensus merge), adapted to the DeepSeek Harness `ctx.web` seam.
> oh-my-pi is MIT-licensed (Mario Zechner, Can Bölük); see
> [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Why

DeepSeek Harness ships search providers that need an API key (DeepSeek, Exa, Perplexity).
This bundle is the credential-free default: each search is an anonymous request to every
public search engine in parallel. A bot-challenged, rate-limited, or down engine is absorbed
— the answer comes from whichever engines responded, and results that several engines agree
on are ranked first. The whole call is bounded by soft/hard deadlines, so a hung engine can
never pin a search to the tool budget.

## Prerequisites

- Node.js 22.19 or newer with npm and pnpm on `PATH`;
- DeepSeek Harness `0.2.1-rc.5` including the standard `dsh` CLI;
- no API keys — nothing else.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.2.1-rc.5 pnpm
dsh --version
```

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-web-search-public
```

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone git@github.com:hy-sde/dsh-plugins.git
cd dsh-plugins/dsh-web-search-public
pnpm install
PACKAGE_TARBALL="$(pnpm pack | tail -n 1)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
cd ../..
```

`pnpm pack` runs the normal `prepack` build and produces a tarball containing `dist/`. A direct
`github:<this-repo>` dependency does not contain built output and is not a supported install
path — always install the built tarball (or the published package).

### Verify the composed configuration

```bash
dsh web --dump-config
```

The composed tree must show `web.config.searchProvider: public` and a `web-search-public-npm`
plugin row loading `@hy-sde-org/dsh-web-search-public` (on harnesses that ship the bundled
provider, the bundled `web-search-public` row shows as disabled).

### Run

```bash
dsh web
```

Ask the agent to `web_search` something. The tool returns rendered sources from the
consensus-merged fan-out.

### Uninstall

```bash
dsh plugin --profile web remove @hy-sde-org/dsh-web-search-public
```

> **Already shipped?** If your harness checkout already mounts `web-search-public` in its base
> bundle (a recent release adopted this provider as the shipped default), you can still install
> this package — the patch disables the bundled row and mounts this package under a distinct
> row id (`web-search-public-npm`), so the provider id `public` is registered exactly once.

## What the bundle does

The package declares a DSH bundle (`dsh.bundle.patch` → `cordis.patch.yml`), so `dsh plugin`
installs it and applies its patch layer to the profile:

1. overrides the `web` row with `config: { searchProvider: public, fetchProvider: http }` —
   the Loader replaces a row's config wholesale, so both keys are restated (the base bundle's
   `fetchProvider: http` is preserved, not dropped),
2. disables the bundled `web-search-public` row when the harness ships one (a no-op patch on
   harnesses without it), and
3. inserts this package as the `web-search-public-npm` plugin row.

The keyed DeepSeek route (`web-search-deepseek`, provider id `deepseek-official`) is **not**
disabled — deployments that prefer it keep their explicit choice by setting
`web.searchProvider: deepseek-official` and providing the `DEEPSEEK_API_KEY` credential.
This bundle mounts no fetch provider of its own and changes no `tool-web` settings; whether
the model can fetch arbitrary URLs is decided by the `tool-web` row of your composition (the
shipped harness base enables `tool-web` fetch). SSRF posture is governed by the fetch
provider's own guards in that row, not by this bundle.

## How the fan-out works

`PublicSearchProvider.search()` races `engines` concurrently (a faithful port of oh-my-pi’s
`searchPublicWeb`):

```text
         ┌────────────────────── fan-out (one query) ──────────────────────┐
         ▼            ▼            ▼            ▼            ▼
     startpage    duckduckgo     ecosia      google       mojeek
         └────────────► consensus merge ◄────────────────┘
```

- Every engine is asked in parallel under one **overall hard deadline** shared by all retry
  attempts. The race returns at the **earliest** of: all engines settled, the **soft deadline**
  (5 s default) with at least one success in hand, or the **hard deadline** (30 s default)
  regardless — then aborts every still-running engine. If the soft deadline passes with no
  success yet and something is still in flight, the call keeps waiting up to the hard deadline
  for the first success.
- Sources are deduplicated across engines (case/`www.`/trailing-slash-normalized URLs) and
  ranked by **cross-engine consensus** — how many engines returned a URL, counting one vote
  per engine even when one engine's answer contains several URL variants of the same page —
  then best rank, then engine order. The most informative snippet wins; the earlier engine’s
  title/URL win equal-rank ties. The provider returns the full merged list; the web seam caps
  it to the request's `maxResults` and sets `truncated` itself.
- Each engine still runs under its own `AbortSignal.timeout(timeoutMs)` race, so an engine
  that ignores the aggregate’s cancellation dies at its own cap.
- **Rate-limit resilience is best-effort, layered, and verdict-driven.** Engine outcomes are
  classified — accepted page (with or without results), challenge wall, HTTP status, transport
  failure, timeout, or canceled. A challenge wall, an HTTP 4xx, or an engine still pending at
  the hard deadline opens *that engine’s* circuit breaker: it is skipped for `engineBackoffMs`
  (5 min default, doubling per consecutive trip up to `maxEngineBackoffMs`), with no request
  sent, and probed again after the window. Retryable transport failures (HTTP 5xx, timeout,
  network fetch failure) retry the whole fan-out after an exponential backoff
  (`maxRetries`/`retryDelayMs`, abort-aware sleep); hard blocks are never retried. Once retries
  are exhausted — or every engine is down — the provider fast-fails for `failureCooldownMs`
  (5 min default) with a `retry in about Ns` error instead of re-blasting engines that just
  throttled us (which would deepen the block). An accepted zero-result page is a query-level
  verdict: it is returned as `[]` and neither retried nor cooled down, and it never trips the
  breaker (an obscure query must not disable an engine).

- Unloading the plugin aborts in-flight searches and drains them before unload completes
  (a disposed provider answers new searches with `WEB_PROVIDER_UNAVAILABLE`).
- A caller abort (`signal.aborted`) aborts the fan-out and throws `WEB_ABORTED`; an aborted
  fetch never escalates to the browser.
- Only if **no engine produced an accepted page** does the provider throw `WEB_PROVIDER_ERROR`
  with each engine’s reason (`id: <reason>; …`) — engines that were still running at the hard
  deadline are listed as `did not settle before the hard deadline`. If at least one engine
  accepted the search and found nothing, the call succeeds with `[]` (`truncated: false`).
- A caller abort (`signal.aborted`) aborts the fan-out and throws `WEB_ABORTED`.
- Only if **every** engine fails does the provider throw `WEB_PROVIDER_ERROR` with each
  engine’s reason (`id: <reason>; …`). Zero organic results, a timed-out engine, and a failed
  HTTP request all count as “this engine has nothing” and are absorbed by the merge.

The worst case for the default configuration is ≈ `hardDeadlineMs` (30 s) overall — the
deadline is the whole budget for the search including retries and their backoff — well under
the 60-second search budget `dsh-tool-web` books in the shipped harness bundle.

### Browser escalation (bot walls)

Google, Ecosia and Mojeek are **browser-backed** (an omp `browserFetch` port): each engine
first tries a plain `fetch` carrying coherent Chrome navigation headers (client hints
derived from its UA), and when that is answered with a bot wall — an enable-JS retry page,
a Cloudflare managed challenge ("Ecosia Firewall"), Mojeek's ALTCHA proof-of-work wall, or
Google's "unusual traffic" `/sorry` gate — it escalates to a real browser via
`ctx.browser.fetchPageHtml` (`@hy-sde-org/dsh-browser` service, stealth `launch` or
CloakBrowser `patch` backend): home-URL cookie seeding, best-effort ready-selector wait, and
ALTCHA auto-solve (force-click of the shadow-DOM checkbox + PoW redirect wait, omp's
`solveCaptcha`). The circuit breaker only opens when every transport — fetch *and* browser —
is blocked.

Escalation resolves the `browser` service lazily at the first challenged fetch, so mount order
never matters — a browser row mounted later still lights the browser-backed engines up. When
no browser service is mounted at escalation time, a challenge trigger is classified as a
challenge (and trips that engine's breaker honestly) while a transport trigger keeps its
retryable classification. `timeoutMs` (default 30 s) is the per-engine budget that covers
fetch → browser steps.

## Configuration

All options are optional; constants fill the defaults. Configure via the plugin row’s
`config:` in your profile patch, or programmatically via `ctx.plugin(...)`.

| Option | Default | Purpose |
| --- | --- | --- |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | engine ids the fan-out races; this order is the tiebreak for consensus ties; unlisted engines stay disabled; an explicit empty array is rejected at activation — omit the key for the default set |
| `timeoutMs` | `30000` | per-engine transport timeout (ms): bounds one engine even if it ignores aggregate cancellation; browser-backed engines may spend it on fetch → stealth-browser escalation, so the default is 30 s |
| `softDeadlineMs` | `5000` | soft aggregate deadline — return as soon as all engines settled or this passes with ≥1 success |
| `hardDeadlineMs` | `30000` | hard aggregate deadline — the overall budget across retries and their backoff; past it the call returns whatever it has, even nothing; must be ≥ `softDeadlineMs` |
| `maxRetries` | `1` | retries for the all-engines-failed aggregate when at least one engine died from a *retryable* transport failure (HTTP 5xx, a timeout, or a network fetch failure). Each retry re-runs the whole fan-out after a backoff, so a short engine throttle that strips the first attempt still yields results. `0` disables retrying. Hard blocks (HTTP 4xx) are never retried — they open that engine’s circuit breaker — and a pure all-`no results` aggregate is query-level and never retried. |
| `retryDelayMs` | `2000` | base delay before retry #1 (ms); doubles on each subsequent attempt. |
| `failureCooldownMs` | `300000` | fast-fail window (ms) after an all-engines-down failure (retry exhausted, or every engine hard-blocked/tripped): searches in this window return a clear `retry in about Ns` error instead of re-blasting engines that just throttled us (which would deepen the block). `0` disables the window. |
| `engineBackoffMs` | `300000` | base per-engine circuit-breaker window (ms): an engine that hard-blocks (HTTP 4xx), answers with a challenge wall, or is still pending at the hard deadline is skipped for this long instead of being re-blasted on every search. Doubles per consecutive trip up to `maxEngineBackoffMs`; resets after a successful probe. `0` disables the per-engine breaker. |
| `maxEngineBackoffMs` | `3600000` | cap for the doubled per-engine circuit-breaker window (ms). |
| `userAgent` | browser-shaped constant | User-Agent sent to the engines (deliberately not the product UA) |

```yaml
- id: web-search-public
  name: '@hy-sde-org/dsh-web-search-public'
  config:
    engines: [startpage, duckduckgo, google, mojeek]   # drop Ecosia, reorder
    timeoutMs: 30000
    softDeadlineMs: 4000
    hardDeadlineMs: 25000
    maxRetries: 1
    retryDelayMs: 2000
    failureCooldownMs: 300000
    engineBackoffMs: 300000
    maxEngineBackoffMs: 3600000
```

`PublicEngineId` values are the exported engine ids; any id outside the known set is dropped
at startup, and an `engines: []` config is rejected at activation with a clear message —
omit the key for the default set (a provider with no engines would be unusable).

## Errors

Search failures use the web seam’s `WEB_*` codes:

| Code | Meaning |
| --- | --- |
| `WEB_PROVIDER_ERROR` | every engine failed; message lists `id: reason; …` |

A rate-limited all-failed aggregate (transport signature, retries exhausted) surfaces the
same `WEB_PROVIDER_ERROR` with `public search engines are rate limited (…); retry in about Ns`.
| `WEB_ABORTED` | caller aborted mid-search |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | configured provider not available |
| `WEB_PROVIDER_CONFIGURED_MISSING` | configured provider id not registered |

## Privacy and security notes

- **No credentials.** The provider never reads a key, so a leak cannot happen. Engines
  receive the query, the browser-shaped User-Agent, and nothing else.
- **Treat queries as public.** Each query is sent to public search engines as an anonymous
  request — including, because of the fan-out, several engines at once. Do not search for
  secrets or PII you would not paste into a public search box.
- **Amplification is inherent.** Every search contacts every configured engine in parallel
  (up to 5 anonymous scrapes per query). That is the price of resilience and consensus, and
  it raises bot-challenge / rate-limit exposure compared with a single-engine chain — see
  [docs/operations.md](docs/operations.md).
- **No fetch provider of our own.** This bundle mounts no fetch provider and changes no
  `tool-web` settings; whether the model can fetch arbitrary URLs is decided by your
  `tool-web` row (the shipped harness base enables fetch), not by this bundle.
- **Redirect policy is per-transport.** The plain-fetch legs of every engine use
  `redirect: "error"` — a redirect is rejected before any `Location` target is contacted.
  When a challenge triggers escalation, the real browser then navigates like a browser and
  follows redirects (it is a normal page navigation — no additional host restriction is
  imposed by this bundle).
- **Challenges are expected.** Startpage, Ecosia, and Google frequently serve bot checks;
  challenge pages are classified as structured `challenge` failures (they trip that engine's
  breaker and are absorbed by the fan-out), never parsed as zero results. See
  [docs/operations.md](docs/operations.md) for runtime expectations.

## Compatibility

| Component | Supported contract |
| --- | --- |
| Node.js | 22.19 or newer |
| DeepSeek Harness | `0.2.1-rc.5` (`@deepseek-ai/dsh-web ^0.2.1-rc.5`, `@deepseek-ai/cordis` peer range) |
| Seam | `ctx.web` `WebSearchProvider` (no key, no fetch provider) |

The provider implements only the `WebSearchProvider` seam contract; the model-facing tool is
`@deepseek-ai/dsh-tool-web`, which this package does not ship. DeepSeek Harness is a
developer preview. Upstream seam-contract changes require a new package release and contract
review.

## Development

```bash
npm ci
npm run check
npm test
npm run build
npm pack --dry-run
```

The default suite runs parser and provider contract tests against fixture HTML (no network),
including the fan-out, consensus merge, and deadline behavior. For live-network validation of
the scrapers against current engine markup, run the opt-in real test — it exercises
Startpage, DuckDuckGo, and Mojeek for organic results and verifies bot-challenged engines
(Ecosia/Google) degrade instead of crashing:

```bash
DSH_WEB_SEARCH_REAL_E2E=1 npm run test:real
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the release checklist and design constraints, and
[docs/operations.md](docs/operations.md) for runtime behavior and troubleshooting.

## License and attribution

This package is licensed MIT — the same license as its upstream
[oh-my-pi](https://github.com/can1357/oh-my-pi). The credential-free engine scrapers and the
parallel `searchPublicWeb` aggregate design are ported from oh-my-pi (MIT License, © Mario
Zechner 2025, © Can Bölük 2025-2026); the upstream copyright holders are recorded in LICENSE
next to this package’s own notice, and the upstream notice text is reproduced in full in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

This plugin is a separate installable package; the harness remains the property of its own
project.
