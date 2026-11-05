/** Search results and challenge markup shared by engine and provider regressions. */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngineId } from '../src/types.ts'

interface EnginePage {
  readonly id: PublicEngineId
  readonly query: string
  readonly resultHtml: string
  readonly wallHtml: string
}

/** Organic result expected from every engine's result fixture. */
export const SEARCH_SOURCE: WebSearchSource = { url: 'https://example.org/docs', title: 'Documentation' }

/** Engine-specific query echoes, organic result cards, and actual challenge elements. */
export const enginePages: readonly EnginePage[] = [
  {
    id: 'google',
    query: 'g-recaptcha unusual traffic',
    resultHtml: '<div id="search"><a href="https://example.org/docs"><h3>Documentation</h3></a></div>',
    wallHtml: '<form action="/sorry/index"><div class="g-recaptcha" data-sitekey="test"></div></form>',
  },
  {
    id: 'ecosia',
    query: 'Ecosia Firewall _cf_chl_opt',
    resultHtml: '<article><a class="result__a" href="https://example.org/docs">Documentation</a></article>',
    wallHtml: '<title>Ecosia Firewall</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script>',
  },
  {
    id: 'mojeek',
    query: 'altcha-widget captcha-wrap Sending automated queries',
    resultHtml: '<ul class="results-standard"><li><h2><a href="https://example.org/docs">Documentation</a></h2></li></ul>',
    wallHtml: '<div class="captcha-wrap"><altcha-widget challengeurl="/challenge"></altcha-widget></div>',
  },
  {
    id: 'duckduckgo',
    query: 'Unfortunately, bots use DuckDuckGo too.',
    resultHtml: '<div class="result"><a class="result__a" href="https://example.org/docs">Documentation</a></div>',
    wallHtml: '<form id="challenge-form" action="//duckduckgo.com/anomaly.js?sv=html" method="post">'
      + '<div class="anomaly-modal__modal"><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></div></form>',
  },
  {
    id: 'startpage',
    query: 'perimeterx px-captcha',
    resultHtml: '<div class="result"><a class="result-title result-link" href="https://example.org/docs">Documentation</a></div>',
    wallHtml: '<div id="px-captcha"></div>',
  },
]

/**
 * Render the query in the title, controls, and body of a result or no-results page.
 * @param query Search terms, escaped as HTML text and attribute content.
 * @param body Engine-specific result markup or an empty-results message.
 * @returns A complete search page with query echoes.
 */
export function queryEchoPage(query: string, body: string): string {
  const escaped = query.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  return `<html><head><title>${escaped} - Search</title></head><body>`
    + `<form><input type="hidden" name="sc" value="token"><input name="q" value="${escaped}"><textarea>${escaped}</textarea></form>`
    + `<h1>Search results for <strong>${escaped}</strong></h1>${body}</body></html>`
}
