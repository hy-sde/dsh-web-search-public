/**
 * Ecosia engine: credential-free Google-indexed results served as static HTML
 * (browser-backed in friction: may be slower or bot-challenged).
 * @module @hy-sde-org/dsh-web-search-public/engines/ecosia
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { anchors, dedupeSources, elementText, elementsByClass, isUsableUrl, stripNoise } from './html.ts'
import { fetchHtml } from './http.ts'

const SEARCH_URL = 'https://www.ecosia.org/search'

export class EcosiaEngine implements PublicEngine {
  readonly id: PublicEngineId = 'ecosia'

  constructor(private readonly userAgent: string) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const url = `${SEARCH_URL}?${new URLSearchParams({ q: request.query, method: 'index' })}`
    const html = await fetchHtml({ url, userAgent: this.userAgent, signal })
    return parseEcosia(html, request.maxResults ?? 10)
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
