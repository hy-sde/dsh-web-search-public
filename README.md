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
- DeepSeek Harness `0.1.1-rc.2` including the standard `dsh` CLI;
- no API keys — nothing else.

Install the Harness CLI and pnpm before continuing:

```bash
npm install --global @deepseek-ai/dsh@0.1.1-rc.2 pnpm
dsh --version
```

## Quick start

### Route A — published npm package (recommended)

```bash
dsh plugin --profile web add @hy-sde-org/dsh-web-search-public
```

### Route B — from source (validate this checkout or hack on the plugin)

```bash
git clone <this-repository-url> dsh-web-search-public
cd dsh-web-search-public
npm ci
PACKAGE_TARBALL="$(npm pack --silent)"
dsh plugin --profile web add "$PWD/$PACKAGE_TARBALL"
cd ..
```

`npm pack` runs the normal `prepack` build and produces a tarball containing `dist/`. A direct
`github:<this-repo>` dependency does not contain built output and is not a supported install
path — always install the built tarball (or the published package).

### Verify the composed configuration

```bash
dsh web --dump-config
```

The composed tree must show `web.config.searchProvider: public` and a `web-search-public`
plugin row loading `@hy-sde-org/dsh-web-search-public`.

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
> bundle (a recent release adopted this package as the shipped default), skip installation
> — it is already the active provider. Adding this bundle on top would duplicate the loader
> row and fail at boot (“duplicate loader entry id”).

## What the bundle does

The package declares a DSH bundle (`dsh.bundle.patch` → `cordis.patch.yml`), so `dsh plugin`
installs it and applies its patch layer to the profile:

1. sets `web.config.searchProvider` to `public` (making the credential-free fan-out the default),
2. inserts the `web-search-public` plugin row.

The keyed DeepSeek route (`web-search-deepseek`, provider id `deepseek-official`) is **not**
disabled — deployments that prefer it keep their explicit choice by setting
`web.searchProvider: deepseek-official` and providing the `DEEPSEEK_API_KEY` credential.
No fetch provider is mounted and `tool-web` keeps `fetch: false`: the model can search, not
fetch arbitrary URLs, which defers SSRF exposure entirely.

## How the fan-out works

`PublicSearchProvider.search()` races `engines` concurrently (a faithful port of oh-my-pi’s
`searchPublicWeb`):

```text
         ┌────────────────────── fan-out (one query) ──────────────────────┐
         ▼            ▼            ▼            ▼            ▼
     startpage    duckduckgo     ecosia      google       mojeek
         └────────────► consensus merge ◄────────────────┘
```

- Every engine is asked in parallel. The race returns at the **earliest** of: all engines
  settled, the **soft deadline** (5 s default) with at least one success in hand, or the
  **hard deadline** (30 s default) regardless — then aborts every still-running engine.
  If the soft deadline passes with no success yet and not everything has failed, the call
  keeps waiting up to the hard deadline for the first success.
- Sources are deduplicated across engines (case/`www.`/trailing-slash-normalized URLs) and
  ranked by **cross-engine consensus** — how many engines returned a URL — then best rank,
  then engine order. The most informative snippet wins; the earlier engine’s title/URL win
  equal-rank ties.
- Each engine still runs under its own `AbortSignal.timeout(timeoutMs)` race, so an engine
  that ignores the aggregate’s cancellation dies at its own cap.

- `available()` is `true` whenever at least one engine is configured — the provider is always
  usable, which is the point.
- A caller abort (`signal.aborted`) aborts the fan-out and throws `WEB_ABORTED`.
- Only if **every** engine fails does the provider throw `WEB_PROVIDER_ERROR` with each
  engine’s reason (`id: <reason>; …`). Zero organic results, a timed-out engine, and a failed
  HTTP request all count as “this engine has nothing” and are absorbed by the merge.

The worst case for the default configuration is ≈ `hardDeadlineMs` (30 s), well under the
60-second search budget `dsh-tool-web` books in the shipped harness bundle.

## Configuration

All options are optional; constants fill the defaults. Configure via the plugin row’s
`config:` in your profile patch, or programmatically via `ctx.plugin(...)`.

| Option | Default | Purpose |
| --- | --- | --- |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | engine ids the fan-out races; this order is the tiebreak for consensus ties; unlisted engines stay disabled |
| `timeoutMs` | `10000` | per-engine transport timeout; bounds one engine even if it ignores aggregate cancellation |
| `softDeadlineMs` | `5000` | soft aggregate deadline — return as soon as all engines settled or this passes with ≥1 success |
| `hardDeadlineMs` | `30000` | hard aggregate deadline — return whatever we have, even nothing; must be ≥ `softDeadlineMs` |
| `userAgent` | browser-shaped constant | User-Agent sent to the engines (deliberately not the product UA) |

```yaml
- id: web-search-public
  name: '@hy-sde-org/dsh-web-search-public'
  config:
    engines: [startpage, duckduckgo, google, mojeek]   # drop Ecosia, reorder
    timeoutMs: 8000
    softDeadlineMs: 4000
    hardDeadlineMs: 25000
```

`PublicEngineId` values are the exported engine ids; any id outside the known set is dropped
at startup, and a zero-engine config makes `available()` false (surfacing
`WEB_PROVIDER_CONFIGURED_UNAVAILABLE`).

## Errors

Search failures use the web seam’s `WEB_*` codes:

| Code | Meaning |
| --- | --- |
| `WEB_PROVIDER_ERROR` | every engine failed; message lists `id: reason; …` |
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
- **No fetch provider.** `tool-web` `fetch: false` stays: the model cannot be pointed at
  arbitrary URLs, so SSRF and unsafe-content surfaces stay closed.
- **Redirect policy.** All engine fetches use `redirect: "error"` — redirects are treated as
  failures and absorbed by the merge rather than leak the caller onto an external location.
- **Challenges are expected.** Startpage, Ecosia, and Google frequently serve bot checks;
  the parsers treat challenged pages as zero results and the fan-out tolerates them. See
  [docs/operations.md](docs/operations.md) for runtime expectations.

## Compatibility

| Component | Supported contract |
| --- | --- |
| Node.js | 22.19 or newer |
| DeepSeek Harness | `0.1.1-rc.2` (`@deepseek-ai/dsh-web`, `@deepseek-ai/cordis` peer range) |
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
