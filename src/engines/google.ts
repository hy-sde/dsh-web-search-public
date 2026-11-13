/**
 * Google engine: credential-free scrape of the classic results page. Google is
 * the most bot-challenged engine in the chain, so this engine is expected to
 * frequently advance the chain rather than succeed. When the plain fetch is
 * answered with an enable-JS retry page, a 403/429, or an "unusual traffic"
 * block, it escalates through the optional host browser service and parses the
 * rendered SERP.
 * @module @hy-sde-org/dsh-web-search-public/engines/google
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { EngineSearchFailure } from '../types.ts'
import { formatScraperQuery, GOOGLE_QUERY_SYNTAX, type PublicSearchRequest } from '../query.ts'
import { challengePageInput, classifyChallengeResponse, describeChallenge, type ChallengeVerdict } from './challenge.ts'
import { browserFetch, type LoadedHtmlPage, type PageScraper } from './browser-page.ts'
import { acceptSearchPage, cleanText, dedupeSources, elementText, elementsByClass, isUsableUrl, parseAttrs, stripNoise } from './html.ts'

const SEARCH_URL = 'https://www.google.com/search'
const GOOGLE_HOME_URL = 'https://www.google.com/'
const RESULT_RENDER_TIMEOUT_MS = 10_000
const RECENCY_TO_TBS = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' } as const


/** Consent cookie so the results page renders in a privacy-basic layout. */
const CONSENT_COOKIE = 'CONSENT=YES+cb.20231217-14-p0.en+FX+116; SOCS=CAISHAgBEhJnd3NfMjAyNTAxMDgtMF9SQzIaAmVuIAEaBgiA_LipBg'

/**
 * Detect blocking responses and challenge evidence (response-header, live-form
 * or structural DOM) with verdict detail, not terms in query/result text.
 * @param page Loaded search response.
 * @returns A challenge verdict, `'traffic'` for status-only walls, or `undefined` for an accepted page.
 */
export function blockVerdict(page: LoadedHtmlPage): ChallengeVerdict | 'traffic' | undefined {
  if (page.status === 403 || page.status === 429 || page.url.includes('/sorry/')) return 'traffic'
  const verdict = classifyChallengeResponse(challengePageInput(page))
  if (verdict === undefined || parseGoogle(page.html, 1).length > 0) return undefined
  return verdict
}

/**
 * Detect blocking responses and challenge markup, not terms in query/result text.
 * @param page Loaded search response.
 * @returns The block reason, or `undefined` for an accepted page.
 */
export function blockReason(page: LoadedHtmlPage): 'javascript' | 'traffic' | undefined {
  const verdict = blockVerdict(page)
  if (verdict === undefined) return undefined
  return verdict === 'traffic' || verdict.protection !== 'JavaScript challenge' ? 'traffic' : 'javascript'
}

export class GoogleEngine implements PublicEngine {
  readonly id: PublicEngineId = 'google'
  readonly querySyntax = GOOGLE_QUERY_SYNTAX

  constructor(private readonly userAgent: string, private readonly scraper?: PageScraper) { }

  async search(request: PublicSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const count = Math.min(Math.max((request.maxResults ?? 9) + 1, 1), 20)
    const params = new URLSearchParams({
      q: formatScraperQuery(request.query, request.parsedQuery),
      hl: 'en',
      num: String(count),
    })
    if (request.recency !== undefined) params.set('tbs', RECENCY_TO_TBS[request.recency])
    const page = await browserFetch(`${SEARCH_URL}?${params}`, {
      userAgent: this.userAgent,
      ...(signal !== undefined ? { signal } : {}),
      referer: GOOGLE_HOME_URL,
      headers: { cookie: CONSENT_COOKIE },
      ...(this.scraper !== undefined
        ? {
          browser: {
            scrape: this.scraper,
            homeUrl: GOOGLE_HOME_URL,
            ready: { selector: 'a h3', timeoutMs: RESULT_RENDER_TIMEOUT_MS },
            shouldFallback: (candidate: LoadedHtmlPage) => blockReason(candidate) !== undefined,
          },
        }
        : {}),
    })
    // Block classification is independent of browser availability: without a
    // scraper there is no escalation path, and a known block page must become
    // a structured challenge failure — never a successful empty search.
    const verdict = blockVerdict(page)
    if (verdict !== undefined) {
      const detail = typeof verdict === 'string' ? verdict : describeChallenge(verdict)
      throw new EngineSearchFailure('challenge', `google answered with a bot challenge page (${detail})`)
    }
    return acceptSearchPage(this.id, page.html, parseGoogle(page.html, Number.POSITIVE_INFINITY))
  }
}

/** Resolve Google's `/url?q=` redirect wrapper; other usable URLs pass through. Exported for tests. */
export function unwrapGoogleHref(href: string): string | undefined {
  if (href.startsWith('/url?q=')) {
    try {
      const target = new URL(href, 'https://www.google.com').searchParams.get('q')
      if (target === null) return undefined
      return isUsableUrl(target) ? target : undefined
    } catch {
      return undefined
    }
  }
  return isUsableUrl(href) ? href : undefined
}

/** Parse Google's classic results page. Exported for contract tests. */
export function parseGoogle(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  const searchIndex = doc.indexOf('<div id="search"')
  const region = searchIndex >= 0 ? doc.slice(searchIndex) : doc

  // Organic results are anchors wrapping an `<h3>`; ad and navigation noise is
  // filtered by requiring an `h3` child and a usable href. Every h3-anchored
  // candidate is kept as a WINDOW BOUNDARY even when invalid, so a rejected
  // card's snippet cannot bleed into the previous result's window. Each entry
  // remembers its anchor's offset so snippets pair by POSITION IN THE PAGE.
  const candidates: { href: string | undefined; title: string | undefined; index: number }[] = []
  // The unrestricted-char alternative must exclude BOTH quote characters:
  // letting it consume apostrophes gives every single-quoted attribute two
  // consumption paths, which backtracks exponentially on an unclosed anchor
  // (a synchronous block no search deadline can contain).
  for (const match of region.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/a>/g)) {
    const inner = match[2] ?? ''
    if (!/<h3[\s>]/i.test(inner)) continue
    const attrs = parseAttrs(match[1] ?? '')
    const href = unwrapGoogleHref(attrs.href ?? '')
    const title = cleanText(inner)
    // Push EVERY h3-anchored candidate — even one with an unusable href or
    // empty title — so it still closes the previous result's snippet window.
    const usable = href !== undefined && title.length > 0
    candidates.push({ href: usable ? href : undefined, title: usable ? title : undefined, index: match.index })
  }

  const snippetTags = elementsByClass(region, 'VwiC3b', 'div')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < candidates.length && sources.length < limit; i += 1) {
    const candidate = candidates[i]
    if (candidate === undefined || candidate.href === undefined || candidate.title === undefined) continue
    // Pair each result with the snippet tag that follows its own anchor and
    // precedes the next organic anchor. Pairing the two lists by position
    // mis-attributes snippets whenever any result lacks one.
    const windowEnd = candidates[i + 1]?.index ?? region.length
    const snippetTag = snippetTags.find(tag => tag.start >= candidate.index && tag.start < windowEnd)
    const snippet = snippetTag === undefined ? undefined : elementText(region, snippetTag)
    sources.push({
      url: candidate.href,
      title: candidate.title,
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return dedupeSources(sources)
}
