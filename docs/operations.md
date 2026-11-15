# Operations notes

Runtime behavior, expectations, and troubleshooting for the credential-free search fan-out.

## Worst-case latency

Each search contacts every configured engine in parallel and is bounded by two aggregate
deadlines: `softDeadlineMs` (default 5 s) and `hardDeadlineMs` (default 30 s). The hard
deadline is the **overall** budget for the whole search — including any retries and their
backoff — not per attempt. The call returns at the earliest of: all engines settled, the
soft deadline with at least one success in hand, or the hard deadline regardless — then
aborts still-running engines. The worst case is therefore ≈ `hardDeadlineMs` (30 s default),
well under the 60-second search budget `dsh-tool-web` books in the shipped harness bundle.
If you raise `hardDeadlineMs` toward or past 60 s, give `tool-web` a matching
`searchTimeoutMs` in your profile patch.

A note on the soft deadline: the aggregate deliberately waits for stragglers up to
`softDeadlineMs` to enrich consensus, so even when one engine answers instantly, a slower
engine can hold the call to the soft window. Lower `softDeadlineMs` for lower latency at the
cost of thinner consensus.

`maxConcurrentPerEngine` counts raw engine operations. A timed-out facade aborts its
operation but retains the slot until that operation settles, so signal-ignoring cleanup cannot
overlap another request to the same engine. Queue time consumes the aggregate deadline; an
admitted attempt uses only the remaining budget.

## Engine expectations (July-2026 baseline)

| Engine | Typical live behavior | Failure mode |
| --- | --- | --- |
| Startpage | organic results via `div.result`; homepage GET plus search POST | bot challenge → structured `challenge` failure |
| DuckDuckGo | organic results via `div.result__body`; wrapper URLs unwrapped; ads skipped | recognized challenge or unrecognized page → structured failure |
| Ecosia | `a.result__a` + `p.result__quote`; frequently 403 for headless clients | HTTP 403 or challenge → breaker trip; optional browser escalation |
| Google | consent-cookie scrape of `div#search` `<h3>` anchors | consent/JS wall → challenge; optional browser escalation |
| Mojeek | `ul.results-standard` / `li` / `h2` anchors + `p.s` | ALTCHA wall → challenge; optional browser escalation |


Challenge classification mirrors the harness-core rule: a `cf-mitigated: challenge` response
header or a live `js_challenge` form field names the protection on any status, body markers
(`_cf_chl_opt`, `captcha-delivery.com`, `px-captcha`, …) are trusted only on non-2xx responses,
and structural DOM evidence names the protection only when the page yielded zero organic
results. An ordinary 2xx page that merely quotes or embeds these markers is not a wall.

The engine list and markup are validated by the opt-in real test
(`DSH_WEB_SEARCH_REAL_E2E=1 npm run test:real`). Engine markup changes (or bot-challenge
policy changes) are the main reason a parser breaks; re-run the real test after any parser
change and record what you observed.

## Outbound request profile

- User-Agent: a browser-shaped constant defined in `src/types.ts`. It deliberately differs
  from `web-fetch-http`’s product User-Agent so search engines receive a realistic client
  rather than a crawler identity.
- Accept: `text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.5`, plus an
  accept-language header.
- Body limits: plain-fetch responses are capped at 2 MiB while streaming; rendered browser
  HTML is rejected above 2 Mi characters.
- Redirects: plain-fetch legs use `redirect: "error"`. Browser escalation follows redirects
  and may load subresources like a normal page.
- Fan-out: compatible configured engines are contacted per query. An engine that cannot
  enforce an `intext:` or absolute-date constraint is skipped and named in the result notice.
  Startpage makes two top-level requests; browser escalation may add home-page navigation,
  target navigation, redirects, subresources, and a bounded Mojeek retry.
- There is no IP pooling. Browser-engine cookies and storage may persist in the scraper
  context owned by the mounted browser service.

## When results look wrong

1. **No engine produced an accepted page** → the tool returns `WEB_PROVIDER_ERROR` with
   per-engine reasons: challenge, HTTP status, invalid or oversized response, timeout,
   transport error, or hard-deadline expiry.
2. **One engine is flaky or incompatible with strict query operators** → the fan-out absorbs
   it and returns a structured notice. Nonempty partial results report
   `search coverage was degraded (…)`; empty partial results report
   `no engine returned results (…)`.
3. **A search legitimately has no matches** → only a page with an explicit no-results marker
   is accepted as `[]`; unknown HTTP-200 HTML remains a retryable engine failure.
4. **Want a different engine set or order** → configure `engines`.
5. **Want tighter latency or less amplification** → lower `softDeadlineMs`, shorten
   `engines`, lower `maxConcurrentPerEngine`, or combine them.
6. **Over-narrow query returns `[]` with a filter notice** → positive dimensions are strict
   unless `relaxPositiveConstraints: true`; negative filters are always strict. Unsupported
   Boolean combinations are forwarded verbatim. Engines that cannot enforce body-text or
   absolute-date constraints are skipped rather than returning unverified matches.
7. **Notices or recency are absent from a model tool call on Harness 0.2.2-rc.3** → that
   published `dsh-tool-web` does not render notices or expose recency. Programmatic `ctx.web`
   calls retain both; use `after:`/`before:` query operators for model calls on that release.
8. **Want the DeepSeek route** → set `web.searchProvider: deepseek-official` and provide
   `DEEPSEEK_API_KEY`.

## Privacy hygiene

- Queries go to all configured public engines verbatim. Never search with secrets or PII.
- The plugin reads no API key or account token. Requests include the browser-shaped user
  agent, Google's fixed consent cookie on Google requests, and engine-issued state retained
  by the mounted browser service's scraper context.
- If a deployment must not disclose a query to third parties, do not use this provider.
