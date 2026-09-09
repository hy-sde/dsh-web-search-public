# Operations notes

Runtime behavior, expectations, and troubleshooting for the credential-free search fan-out.

## Worst-case latency

Each search contacts every configured engine in parallel and is bounded by two aggregate
deadlines: `softDeadlineMs` (default 5 s) and `hardDeadlineMs` (default 30 s). The call
returns at the earliest of: all engines settled, the soft deadline with at least one success
in hand, or the hard deadline regardless — then aborts still-running engines. The worst
case is therefore ≈ `hardDeadlineMs` (30 s default), well under the 60-second search budget
`dsh-tool-web` books in the shipped harness bundle. If you raise `hardDeadlineMs` toward or
past 60 s, give `tool-web` a matching `searchTimeoutMs` in your profile patch.

A note on the soft deadline: the aggregate deliberately waits for stragglers up to
`softDeadlineMs` to enrich consensus, so even when one engine answers instantly, a slower
engine can hold the call to the soft window. Lower `softDeadlineMs` for lower latency at the
cost of thinner consensus.

## Engine expectations (July-2026 baseline)

| Engine | Typical live behavior | Failure mode |
| --- | --- | --- |
| Startpage | organic results via the `div.result` / `a.result-title` / `p.description` markup; two requests (home for hidden fields, then POST) | bot challenge → zero results |
| DuckDuckGo | organic results via `div.result__body`; `uddg` redirect unwrap; `publishedAt` from result timestamps; paid `y.js` ad rows skipped | rate limit → zero results |
| Ecosia | `a.result__a` + `p.result__quote`; frequently 403 for headless clients | HTTP 403 → zero results |
| Google | consent-cookie scrape of `div#search` `<h3>`-anchors; frequently challenged | consent/JS wall → zero results |
| Mojeek | `ul.results-standard` / `li` / `h2`-anchors + `p.s`; least hostile of the group | rare; zero results on rate limit |

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
- Redirects: rejected (`redirect: "error"`).
- Fan-out: **all configured engines are contacted per query** (up to 5 concurrent anonymous
  requests, plus Startpage’s two-request handshake). There is no shared session, cookie jar,
  or IP pooling beyond what the platform itself provides. Expect higher bot-challenge /
  rate-limit pressure on the engine hosts than a single-engine chain would produce.

## When results look wrong

1. **All engines failed** → the tool returns `WEB_PROVIDER_ERROR` with a `id: reason; …`
   message. Reasons are `ok-but-empty` (challenged or no organic results), `timed out`,
   `HTTP <status>`, or a transport error.
2. **One engine is flaky** → the fan-out absorbs it: its empty/challenged answers simply do
   not contribute to the consensus merge. Check that engine’s markup against its parser with
   the real test.
3. **Want a different engine set or order** → set `engines` in the plugin config (see
   README). Engines not listed are never queried.
4. **Want tighter latency / less amplification** → lower `softDeadlineMs`, shorten the
   `engines` list, or both; the consensus becomes thinner and the merge cheaper.
5. **Want the DeepSeek route** → keep this bundle installed for the fallback and set
   `web.searchProvider: deepseek-official` plus the `DEEPSEEK_API_KEY` credential.

## Privacy hygiene

- Queries go to public engines verbatim and, because of the fan-out, to several of them at
  once — never search with secrets or PII.
- No key material, no tokens, and no cookies are ever sent; the only per-request data is the
  query, the fixed headers, and your source IP.
- If your deployment must not disclose a query to third parties, do not use this provider —
  use a keyed provider (e.g. `deepseek-official`) whose retrieval stays inside its own API.
