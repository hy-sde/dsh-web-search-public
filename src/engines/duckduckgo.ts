/**
 * DuckDuckGo engine: static HTML endpoint, no credentials, parseable without JS.
 * @module @hy-sde-org/dsh-web-search-public/engines/duckduckgo
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'
import { EngineSearchFailure, type PublicEngine, type PublicEngineId } from '../types.ts'
import { DUCKDUCKGO_QUERY_SYNTAX, formatScraperQuery, parseSearchQuery, type PublicSearchRequest } from '../query.ts'
import { challengePageInput, classifyChallengeResponse, describeChallenge } from './challenge.ts'
import { acceptSearchPage, anchors, cleanText, elementText, elementsByClass, isUsableUrl, stripNoise } from './html.ts'
import { fetchHtml, isOkStatus } from './http.ts'

const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/'
const RECENCY_TO_DF = { day: 'd', week: 'w', month: 'm', year: 'y' } as const
/** DuckDuckGo's documented `kl` locale values. */
const DDG_KL_CODES: Readonly<Record<string, true>> = {
  'xa-ar': true, 'xa-en': true, 'ar-es': true, 'au-en': true, 'at-de': true,
  'be-fr': true, 'be-nl': true, 'br-pt': true, 'bg-bg': true, 'ca-en': true,
  'ca-fr': true, 'ct-ca': true, 'cl-es': true, 'cn-zh': true, 'co-es': true,
  'hr-hr': true, 'cz-cs': true, 'dk-da': true, 'ee-et': true, 'fi-fi': true,
  'fr-fr': true, 'de-de': true, 'gr-el': true, 'hk-tzh': true, 'hu-hu': true,
  'in-en': true, 'id-id': true, 'id-en': true, 'ie-en': true, 'il-he': true,
  'it-it': true, 'jp-jp': true, 'kr-kr': true, 'lv-lv': true, 'lt-lt': true,
  'xl-es': true, 'my-ms': true, 'my-en': true, 'mx-es': true, 'nl-nl': true,
  'nz-en': true, 'no-no': true, 'pe-es': true, 'ph-en': true, 'ph-tl': true,
  'pl-pl': true, 'pt-pt': true, 'ro-ro': true, 'ru-ru': true, 'sg-en': true,
  'sk-sk': true, 'sl-sl': true, 'za-en': true, 'es-es': true, 'se-sv': true,
  'ch-de': true, 'ch-fr': true, 'ch-it': true, 'tw-tzh': true, 'th-th': true,
  'tr-tr': true, 'ua-uk': true, 'uk-en': true, 'us-en': true, 'ue-es': true,
  've-es': true, 'vn-vi': true, 'wt-wt': true,
}

/** BCP 47 locales whose DuckDuckGo code is not a component swap. */
const DDG_LOCALE_ALIASES: Readonly<Record<string, string>> = {
  'ca-es': 'ct-ca',
  'en-gb': 'uk-en',
  'es-419': 'xl-es',
  'es-us': 'ue-es',
  'ja-jp': 'jp-jp',
  'ko-kr': 'kr-kr',
  'zh-hk': 'hk-tzh',
  'zh-tw': 'tw-tzh',
}

/** Map a parsed BCP 47 `lang:` value to DuckDuckGo's provider-specific `kl`. */
export function localeToKl(lang: string | undefined): string | undefined {
  if (lang === undefined) return undefined
  const locale = lang.toLowerCase().replaceAll('_', '-')
  const alias = DDG_LOCALE_ALIASES[locale]
  if (alias !== undefined) return alias
  const match = /^([a-z]{2})-([a-z]{2})$/.exec(locale)
  if (match === null) return undefined
  const candidate = `${match[2]}-${match[1]}`
  return DDG_KL_CODES[candidate] === true ? candidate : undefined
}


/** A `WebSearchSource` may use `title`/optional fields; built via guarded assignment. */
export class DuckDuckGoEngine implements PublicEngine {
  readonly id: PublicEngineId = 'duckduckgo'
  readonly querySyntax = DUCKDUCKGO_QUERY_SYNTAX

  constructor(private readonly userAgent: string) {}

  async search(request: PublicSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const parsedQuery = request.parsedQuery ?? parseSearchQuery(request.query)
    const form = new URLSearchParams({
      q: formatScraperQuery(request.query, parsedQuery, DUCKDUCKGO_QUERY_SYNTAX),
      kl: localeToKl(parsedQuery.lang) ?? 'us-en',
    })
    if (request.recency !== undefined) form.set('df', RECENCY_TO_DF[request.recency])
    const page = await fetchHtml({
      url: HTML_ENDPOINT,
      method: 'POST',
      body: form.toString(),
      userAgent: this.userAgent,
      signal,
    })
    const sources = parseDuckDuckGo(page.html, Number.POSITIVE_INFINITY)
    if (sources.length === 0) {
      const verdict = classifyChallengeResponse(challengePageInput(page))
      if (verdict !== undefined) {
        throw new EngineSearchFailure('challenge', `duckduckgo answered with a bot challenge page (${describeChallenge(verdict)})`)
      }
    }
    if (!isOkStatus(page.status)) {
      throw new EngineSearchFailure('http', `HTTP ${page.status}`, page.status)
    }
    return acceptSearchPage(this.id, page.html, sources)
  }
}

/** Unwrap DuckDuckGo's `uddg` redirect parameter; other http(s) hrefs pass through. */
export function unwrapDdgHref(href: string): string | undefined {
  if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
    const target = new URL(href, 'https://duckduckgo.com').searchParams.get('uddg')
    if (target === null) return undefined
    return isUsableUrl(target) ? target : undefined
  }
  return isUsableUrl(href) ? href : undefined
}

/** Parse DuckDuckGo's static HTML results page into sources. Exported for contract tests. */
export function parseDuckDuckGo(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  const rows = elementsByClass(doc, 'result', 'div')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < rows.length && sources.length < limit; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const end = rows[i + 1]?.start ?? doc.length
    const source = parseDuckDuckGoRow(doc.slice(row.end, end))
    if (source !== undefined) sources.push(source)
  }
  return sources
}

function parseDuckDuckGoRow(slice: string): WebSearchSource | undefined {
  const titleAnchor = anchors(slice).find(anchor => (anchor.attrs.class ?? '').split(/\s+/).includes('result__a'))
  if (titleAnchor === undefined) return undefined
  // Paid results arrive as `//duckduckgo.com/y.js?...` ad redirects carrying
  // `ad_provider`/`ad_domain` query params; skip them, keeping only organic rows.
  if (/^\/\/duckduckgo\.com\/y\.js\?/.test(titleAnchor.href)
    || /[?&](ad_provider|ad_domain)=/.test(titleAnchor.href)) return undefined
  const url = unwrapDdgHref(titleAnchor.href)
  if (url === undefined) return undefined

  const title = cleanText(titleAnchor.text)
  const snippetTag = elementsByClass(slice, 'result__snippet').find(tag => tag.tag === 'a' || tag.tag === 'div')
  const snippet = snippetTag === undefined ? undefined : elementText(slice, snippetTag)
  const dateTag = elementsByClass(slice, 'result__timestamp').at(0)
  const date = dateTag === undefined ? undefined : elementText(slice, dateTag)
  const iso = date === undefined ? undefined : /^\d{4}-\d{2}-\d{2}/.exec(date.trim())?.[0]

  return {
    url,
    ...(title.length > 0 ? { title } : {}),
    ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
    ...(iso !== undefined ? { publishedAt: iso } : {}),
  }
}
