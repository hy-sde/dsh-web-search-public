/**
 * Ecosia engine: credential-free Google-indexed results served as static HTML.
 * Browser-backed (omp port): escalates to the host's stealth browser when
 * Cloudflare answers the plain fetch with an "Ecosia Firewall" managed
 * challenge instead of results.
 * @module @hy-sde-org/dsh-web-search-public/engines/ecosia
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { browserFetch, type LoadedHtmlPage, type PageScraper } from './browser-page.ts'
import { anchors, dedupeSources, elementText, elementsByClass, isUsableUrl, stripNoise } from './html.ts'

const SEARCH_URL = 'https://www.ecosia.org/search'
const ECOSIA_HOME_URL = 'https://www.ecosia.org/'
const RESULT_RENDER_TIMEOUT_MS = 10_000

/**
 * `true` when Ecosia's Cloudflare front answered with the managed challenge
 * instead of results: a 403 titled "Ecosia Firewall" carrying the `_cf_chl_opt`
 * bootstrap and the challenge-platform loader. Exported for tests.
 */
export function isBlockedPage(page: LoadedHtmlPage): boolean {
  return (
    page.status === 403 ||
    page.status === 429 ||
    page.html.includes('Ecosia Firewall') ||
    page.html.includes('_cf_chl_opt') ||
    page.html.includes('/cdn-cgi/challenge-platform/') ||
    /confirm you.{0,3}re not a robot/i.test(page.html)
  )
}

export class EcosiaEngine implements PublicEngine {
  readonly id: PublicEngineId = 'ecosia'

  constructor(private readonly userAgent: string, private readonly scraper?: PageScraper) { }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: request.query, method: 'index' })}`
    const page = await browserFetch(url, {
      userAgent: this.userAgent,
      ...(signal !== undefined ? { signal } : {}),
      referer: ECOSIA_HOME_URL,
      ...(this.scraper !== undefined
        ? {
          browser: {
            scrape: this.scraper,
            homeUrl: ECOSIA_HOME_URL,
            ready: { selector: 'article[data-test-id="organic-result"]', timeoutMs: RESULT_RENDER_TIMEOUT_MS },
            shouldFallback: isBlockedPage,
          },
        }
        : {}),
    })
    return parseEcosia(page.html, request.maxResults ?? 10)
  }
}

/** Parse Ecosia's server-rendered result page. Exported for contract tests. */
export function parseEcosia(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  const links = anchors(doc)
    .filter(anchor => isUsableUrl(anchor.href) && /(?:^|\s)result__a(?:$|\s)/.test(anchor.attrs.class ?? ''))
  const snippetTags = elementsByClass(doc, 'result__quote')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < links.length && sources.length < limit; i += 1) {
    const link = links[i]
    if (link === undefined) continue
    const snippetTag = snippetTags[i]
    const snippet = snippetTag === undefined ? undefined : elementText(doc, snippetTag)
    sources.push({
      url: link.href,
      ...(link.text.length > 0 ? { title: link.text } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return dedupeSources(sources)
}
