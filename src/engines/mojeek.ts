/**
 * Mojeek engine: independent index, credential-free and the most no-JS friendly
 * engine in the chain.
 * @module @hy-sde-org/dsh-web-search-public/engines/mojeek
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { cleanText, elementText, elementsByClass, isUsableUrl, scanTags, stripNoise } from './html.ts'
import { fetchHtml } from './http.ts'

const SEARCH_URL = 'https://www.mojeek.com/search'

export class MojeekEngine implements PublicEngine {
  readonly id: PublicEngineId = 'mojeek'

  constructor(private readonly userAgent: string) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: request.query, s: 'NS', l: 'en' })}`
    const html = await fetchHtml({ url, userAgent: this.userAgent, signal })
    return parseMojeek(html, request.maxResults ?? 10)
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
