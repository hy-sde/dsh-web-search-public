/**
 * Ecosia engine: credential-free Google-indexed results served as static HTML.
 * Browser-backed (omp port): escalates to the host's stealth browser when
 * Cloudflare answers the plain fetch with an "Ecosia Firewall" managed
 * challenge instead of results.
 * @module @hy-sde-org/dsh-web-search-public/engines/ecosia
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { EngineSearchFailure } from '../types.ts'
import { browserFetch, type LoadedHtmlPage, type PageScraper } from './browser-page.ts'
import { classifyChallengePage } from './challenge.ts'
import { anchors, dedupeSources, elementText, elementsByClass, isUsableUrl, stripNoise } from './html.ts'

const SEARCH_URL = 'https://www.ecosia.org/search'
const ECOSIA_HOME_URL = 'https://www.ecosia.org/'
const RESULT_RENDER_TIMEOUT_MS = 10_000

/**
 * Detect blocking statuses and challenge markup without rejecting query echoes.
 * @param page Loaded search response.
 * @returns Whether browser escalation or a challenge failure is required.
 */
export function isBlockedPage(page: LoadedHtmlPage): boolean {
  return page.status === 403 || page.status === 429
    || (classifyChallengePage(page.html) !== undefined && parseEcosia(page.html, 1).length === 0)
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
    // Block classification is independent of browser availability: without a
    // scraper there is no escalation path, and a known block page must become
    // a structured challenge failure — never a successful empty search.
    if (isBlockedPage(page)) {
      throw new EngineSearchFailure('challenge', 'ecosia answered with a bot challenge page')
    }
    return parseEcosia(page.html, request.maxResults ?? 10)
  }
}

/** Parse Ecosia's server-rendered result page. Exported for contract tests. */
export function parseEcosia(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  // Every result__a anchor is a WINDOW BOUNDARY even when its href is
  // unusable, so a rejected card's snippet cannot bleed into the previous
  // result's window.
  const candidates = anchors(doc)
    .filter(anchor => /(?:^|\s)result__a(?:$|\s)/.test(anchor.attrs.class ?? ''))
  const snippetTags = elementsByClass(doc, 'result__quote')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < candidates.length && sources.length < limit; i += 1) {
    const link = candidates[i]
    if (link === undefined || !isUsableUrl(link.href)) continue
    // Pair each link with the snippet tag that follows it and precedes the
    // next result link — pairing the two lists by position mis-attributes
    // snippets whenever any result lacks one.
    const windowEnd = candidates[i + 1]?.start ?? doc.length
    const snippetTag = snippetTags.find(tag => tag.start >= link.start && tag.start < windowEnd)
    const snippet = snippetTag === undefined ? undefined : elementText(doc, snippetTag)
    sources.push({
      url: link.href,
      ...(link.text.length > 0 ? { title: link.text } : {}),
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return dedupeSources(sources)
}
