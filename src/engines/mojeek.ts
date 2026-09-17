/**
 * Mojeek engine: independent index, credential-free and the most no-JS friendly
 * engine in the chain. Browser-backed (omp port): escalates to the host's
 * stealth browser when the plain fetch is answered with the ALTCHA
 * proof-of-work wall ("altcha-widget") or an "automated queries" refusal — the
 * browser solves the PoW itself, so the escalation waits for the results list
 * and retries once.
 * @module @hy-sde-org/dsh-web-search-public/engines/mojeek
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { browserFetch, type LoadedHtmlPage, type PageScraper } from './browser-page.ts'
import { cleanText, elementText, elementsByClass, isUsableUrl, scanTags, stripNoise } from './html.ts'

const SEARCH_URL = 'https://www.mojeek.com/search'
const MOJEEK_HOME_URL = 'https://www.mojeek.com/?arc=none&lang=en&lb=en&theme=dark'
const CAPTCHA_SOLVE_TIMEOUT_MS = 45_000

/** ALTCHA / robot-wall classification. Exported for tests. */
export function isRobotPage(page: LoadedHtmlPage): boolean {
  return (
    (page.html.includes('altcha-widget') ||
      page.html.includes('captcha-wrap') ||
      /sending automated queries/i.test(page.html)) &&
    !page.html.includes('results-standard')
  )
}

export class MojeekEngine implements PublicEngine {
  readonly id: PublicEngineId = 'mojeek'

  constructor(private readonly userAgent: string, private readonly scraper?: PageScraper) { }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: request.query, s: 'NS', l: 'en' })}`
    const page = await browserFetch(url, {
      userAgent: this.userAgent,
      ...(signal !== undefined ? { signal } : {}),
      referer: MOJEEK_HOME_URL,
      ...(this.scraper !== undefined
        ? {
          browser: {
            scrape: this.scraper,
            homeUrl: MOJEEK_HOME_URL,
            altcha: { resultsSelector: 'ul.results-standard li', waitMs: CAPTCHA_SOLVE_TIMEOUT_MS },
            shouldFallback: isRobotPage,
            attempts: 2,
            retryDelayMs: 1_000,
          },
        }
        : {}),
    })
    return parseMojeek(page.html, request.maxResults ?? 10)
  }
}

/** Parse Mojeek's `ul.results-standard` list. Exported for contract tests. */
export function parseMojeek(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  const list = elementsByClass(doc, 'results-standard', 'ul').at(0)
  if (list === undefined) return []
  const closeIndex = doc.indexOf('</ul>', list.end)
  const region = doc.slice(list.end, closeIndex >= 0 ? closeIndex : doc.length)
  const items = scanTags(region, tag => tag === 'li')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < items.length && sources.length < limit; i += 1) {
    const item = items[i]
    if (item === undefined) continue
    const end = items[i + 1]?.start ?? region.length
    const source = parseMojeekRow(region.slice(item.end, end))
    if (source !== undefined) sources.push(source)
  }
  return sources
}

function parseMojeekRow(slice: string): WebSearchSource | undefined {
  const titleMatch = /<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(slice)
  const href = titleMatch?.[1]
  if (!isUsableUrl(href)) return undefined
  const title = titleMatch === null ? '' : cleanText(titleMatch[2] ?? '')

  const snippetTag = scanTags(slice, (t, attrs) => t === 'p' && (attrs.class ?? '').split(/\s+/).includes('s')).at(0)
  const snippet = snippetTag === undefined ? undefined : elementText(slice, snippetTag)

  return {
    url: href,
    ...(title.length > 0 ? { title } : {}),
    ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
  }
}
