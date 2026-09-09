/**
 * Startpage engine: lifts the anonymous search form's hidden fields from the
 * homepage, then posts the query. Results are Google-indexed but the page is
 * parseable without JS (may be bot-challenged).
 * @module @hy-sde-org/dsh-web-search-public/engines/startpage
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { PublicEngine, PublicEngineId } from '../types.ts'
import { anchors, elementText, elementsByClass, isUsableUrl, scanTags, stripNoise } from './html.ts'
import { fetchHtml } from './http.ts'

const HOME_URL = 'https://www.startpage.com/'
const SEARCH_URL = 'https://www.startpage.com/sp/search'

export class StartpageEngine implements PublicEngine {
  readonly id: PublicEngineId = 'startpage'

  constructor(private readonly userAgent: string) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const home = await fetchHtml({ url: HOME_URL, userAgent: this.userAgent, signal })
    const hidden = collectHiddenInputs(home)
    const form = new URLSearchParams({ ...hidden, query: request.query, lang: 'english' })
    const html = await fetchHtml({
      url: SEARCH_URL,
      method: 'POST',
      body: form.toString(),
      userAgent: this.userAgent,
      signal,
    })
    return parseStartpage(html, request.maxResults ?? 10)
  }
}

/** Hidden fields Startpage's search form needs; the `query` field is supplied by callers. Exported for tests. */
export function collectHiddenInputs(html: string): Record<string, string> {
  const doc = stripNoise(html)
  const out: Record<string, string> = {}
  for (const open of scanTags(doc, tag => tag === 'input')) {
    const { type, name, value } = open.attrs
    if (name === undefined || name === '') continue
    if (name.toLowerCase() === 'query') continue
    if (type !== undefined && type !== '' && type !== 'hidden') continue
    out[name] = value ?? ''
  }
  return out
}

/** Parse Startpage's result page. Exported for contract tests. */
export function parseStartpage(html: string, limit: number): WebSearchSource[] {
  const doc = stripNoise(html)
  const rows = elementsByClass(doc, 'result', 'div')
  const sources: WebSearchSource[] = []
  for (let i = 0; i < rows.length && sources.length < limit; i += 1) {
    const row = rows[i]
    if (row === undefined) continue
    const end = rows[i + 1]?.start ?? doc.length
    const source = parseStartpageRow(doc.slice(row.end, end))
    if (source !== undefined) sources.push(source)
  }
  return sources
}

function parseStartpageRow(slice: string): WebSearchSource | undefined {
  const link = anchors(slice).find(anchor =>
    isUsableUrl(anchor.href) && anchor.text.length > 0
    && (anchor.attrs.class ?? '').split(/\s+/).includes('result-title')
    && !anchor.href.includes('startpage.com/sp/search'))
  if (link === undefined) return undefined

  const title = link.text
  const snippetTag = elementsByClass(slice, 'description', 'p').at(0)
  const snippet = snippetTag === undefined ? undefined : elementText(slice, snippetTag)

  return {
    url: link.href,
    ...(title.length > 0 ? { title } : {}),
    ...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
  }
}
