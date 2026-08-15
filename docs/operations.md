# Operations notes

Runtime behavior, expectations, and troubleshooting for the credential-free search chain.

## Worst-case latency

The chain’s worst case is `engines.length × timeoutMs` (default `5 × 10 s`). `dsh-tool-web`
books a 60-second search budget in the shipped harness bundle, which covers the default
worst case. If you raise `timeoutMs` or lengthen the engine list, give `tool-web` a matching
`searchTimeoutMs` in your profile patch.

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
- Each engine request is one independent HTTP round; there is no shared session, cookie jar,
  or IP pooling beyond what the platform itself provides.

## When results look wrong

1. **All engines failed** → the tool returns `WEB_PROVIDER_ERROR` with a `id: reason; …`
   message. Reasons are `ok-but-empty` (challenged or no organic results), `timed out`,
   `HTTP <status>`, or a transport error.
2. **One engine is flaky** → the chain simply skips it. Check that engine’s markup against
   its parser with the real test.
3. **Want a different order** → set `engines` in the plugin config (see README). Engines not
   listed are not tried.
4. **Want the DeepSeek route** → keep this bundle installed for the fallback and set
   `web.searchProvider: deepseek-official` plus the `DEEPSEEK_API_KEY` credential.

## Privacy hygiene

- Queries go to public engines verbatim — never search with secrets or PII.
- No key material, no tokens, and no cookies are ever sent; the only per-request data is the
  query, the fixed headers, and your source IP.
- If your deployment must not disclose a query to third parties, do not use this provider —
  use a keyed provider (e.g. `deepseek-official`) whose retrieval stays inside its own API.

