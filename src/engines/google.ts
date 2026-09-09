/**
 * Google engine: credential-free scrape of the classic results page. Google is
 * the most bot-challenged engine in the chain, so this engine is expected to
 * frequently advance the chain rather than succeed.
 * @module @hy-sde-org/dsh-web-search-public/engines/google
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { cleanText, dedupeSources, elementText, elementsByClass, isUsableUrl, parseAttrs, stripNoise } from './html.ts'
import { fetchHtml } from './http.ts'

const SEARCH_URL = 'https://www.google.com/search'

/** Consent cookie so the results page renders in a privacy-basic layout. */
const CONSENT_COOKIE = 'CONSENT=YES+cb.20231217-14-p0.en+FX+116; SOCS=CAISHAgBEhJnd3NfMjAyNTAxMDgtMF9SQzIaAmVuIAEaBgiA_LipBg'

export class GoogleEngine implements PublicEngine {
  readonly id: PublicEngineId = 'google'

  constructor(private readonly userAgent: string) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const count = Math.min(Math.max(request.maxResults ?? 10, 1), 20)
    const params = new URLSearchParams({ q: request.query, hl: 'en', num: String(count) })
    const html = await fetchHtml({
      url: `${SEARCH_URL}?${params}`,
      headers: { cookie: CONSENT_COOKIE },
      userAgent: this.userAgent,
      signal,
    })
    return parseGoogle(html, request.maxResults ?? 10)
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
  // filtered by requiring an `h3` child and a usable href.
  const organic: { href: string; title: string }[] = []
  for (const match of region.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/a>/g)) {
    const inner = match[2] ?? ''
    if (!/<h3[\s>]/i.test(inner)) continue
    const attrs = parseAttrs(match[1] ?? '')
    const href = unwrapGoogleHref(attrs.href ?? '')
    if (href === undefined) continue
    const title = cleanText(inner)
    if (title.length === 0) continue
    organic.push({ href, title })
  }

  const snippetTags = elementsByClass(region, 'VwiC3b', 'div')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < organic.length && sources.length < limit; i += 1) {
    const result = organic[i]
    if (result === undefined) continue
    const snippetTag = snippetTags[i]
    const snippet = snippetTag === undefined ? undefined : elementText(region, snippetTag)
    sources.push({
      url: result.href,
      title: result.title,
      ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    })
  }
  return dedupeSources(sources)
}
