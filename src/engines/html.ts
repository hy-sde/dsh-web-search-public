/**
 * Minimal, dependency-free HTML scanning helpers for the credential-free engines.
 * @module @hy-sde-org/dsh-web-search-public/engines/html
 */

import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** Comments, scripts, styles, and template content carry no visible results and may contain parser-hostile text. */
export function stripNoise(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, ' ')
}

function fromCodePoint(code: number): string {
  return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code)
    : '\uFFFD'
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-z][a-z0-9]+);/g,
    (whole, entity: string) => {
      if (entity.startsWith('#x')) {
        const code = Number.parseInt(entity.slice(2), 16)
        return Number.isNaN(code) ? whole : fromCodePoint(code)
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10)
        return Number.isNaN(code) ? whole : fromCodePoint(code)
      }
      switch (entity) {
        case 'amp': return '&'
        case 'lt': return '<'
        case 'gt': return '>'
        case 'quot': return '"'
        case 'apos': return "'"
        case 'nbsp': return ' '
        default: return whole
      }
    },
  )
}

export function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ')
}

/** Visible text: tags stripped, HTML entities decoded, whitespace collapsed (including space-before-punctuation). */
export function cleanText(input: string): string {
  return decodeHtmlEntities(stripTags(input))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
}

export interface Tag {
  readonly tag: string
  readonly attrs: Readonly<Record<string, string>>
  readonly start: number
  readonly end: number
}

const TAG_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g

export function parseAttrs(raw: string): Readonly<Record<string, string>> {
  const attrs: Record<string, string> = {}
  for (const match of raw.matchAll(ATTR_RE)) {
    const value = match[2] ?? match[3] ?? match[4]
    // Attribute values are HTML-escaped in the page (e.g. `href="...&amp;...")`);
    // normalize so URL parsing and matching see the real characters.
    const name = match[1]
    if (name === undefined) continue
    attrs[name.toLowerCase()] = decodeHtmlEntities(value ?? '')
  }
  return attrs
}

/** Scan open tags (over noise-stripped input) whose tag and attributes match. */
export function scanTags(
  html: string,
  predicate: (tag: string, attrs: Readonly<Record<string, string>>) => boolean,
): Tag[] {
  const tags: Tag[] = []
  for (const match of html.matchAll(TAG_OPEN_RE)) {
    const tagRaw = match[1]
    const attrs = parseAttrs(match[2] ?? '')
    if (tagRaw === undefined) continue
    const tag = tagRaw.toLowerCase()
    if (predicate(tag, attrs)) {
      // The regex only matched through the tag's own closing `>`, so the first
      // one from `match.index` is exactly the position after the tag name+attrs.
      tags.push({ tag, attrs, start: match.index, end: html.indexOf('>', match.index) + 1 })
    }
  }
  return tags
}

/** Elements whose `class` attribute contains the exact token (optionally limited to one tag). */
export function elementsByClass(html: string, token: string, tag?: string): Tag[] {
  return scanTags(html, (t, attrs) =>
    (tag === undefined || t === tag) && (attrs.class ?? '').split(/\s+/).includes(token))
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

const CLOSE_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/**
 * Visible text inside the element opened by `open`, with balanced same-tag nesting.
 * Scanning is windowed so pathological nesting cannot turn parsing quadratic.
 */
export function elementText(html: string, open: Tag, maxScan = 4096): string | undefined {
  if (VOID_ELEMENTS.has(open.tag)) return ''
  const boundary = Math.min(html.length, open.end + maxScan)
  let depth = 1
  CLOSE_TAG_RE.lastIndex = open.end
  let match: RegExpExecArray | null
  while ((match = CLOSE_TAG_RE.exec(html)) !== null) {
    const tag = match[1]
    if (tag === undefined) continue
    if (match.index >= boundary) return undefined
    const lower = tag.toLowerCase()
    if (lower !== open.tag) continue
    // A closing tag is `</tag`; anything else in this regex match is an opening tag.
    if (html[match.index + 1] !== '/' && !VOID_ELEMENTS.has(lower)) {
      depth += 1
      continue
    }
    depth -= 1
    if (depth === 0) return cleanText(html.slice(open.end, match.index))
  }
  return undefined
}

export interface Anchor {
  readonly href: string
  readonly text: string
  readonly attrs: Readonly<Record<string, string>>
  readonly start: number
  readonly end: number
}

/** Every `<a>` element with its href and visible text. */
export function anchors(html: string): Anchor[] {
  const out: Anchor[] = []
  for (const open of scanTags(html, tag => tag === 'a')) {
    const text = elementText(html, open) ?? ''
    out.push({ href: open.attrs.href ?? '', text, attrs: open.attrs, start: open.start, end: open.end })
  }
  return out
}

/** True when `raw` is an absolute http(s) URL with no javascript:/data:/mailto: scheme. */
export function isUsableUrl(raw: string | undefined): raw is string {
  if (raw === undefined || raw.length === 0 || raw.length > 2048) return false
  if (/^\s*(javascript|data|mailto|vbscript):/i.test(raw)) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** De-duplicate sources by URL, preserving first-seen order. */
export function dedupeSources(sources: readonly WebSearchSource[]): WebSearchSource[] {
  const seen = new Set<string>()
  const out: WebSearchSource[] = []
  for (const source of sources) {
    if (seen.has(source.url)) continue
    seen.add(source.url)
    out.push(source)
  }
  return out
}
