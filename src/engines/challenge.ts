/**
 * Challenge detection from widgets, forms, scripts, and navigation targets.
 * Query text, result text, and quoted HTML inside raw-text elements are not evidence.
 * @module @hy-sde-org/dsh-web-search-public/engines/challenge
 */

import { parseAttrs, scanTags } from './html.ts'

type ChallengeKind = 'javascript' | 'challenge'

const WIDGET = /(?:^|\s)(?:px-captcha|captcha-wrap|altcha-widget|g-recaptcha|cf-turnstile|cf-chl(?:-[^\s]+)?|anomaly-modal__modal)(?:\s|$)/i
const RAW_TEXT = /<(script|style|textarea|title|template)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)(?:<\/\1\s*>|$)/gi
const CLOUDFLARE_BOOTSTRAP = /^\s*(?:\(\s*function\s*\(\s*\)\s*\{\s*)?window\._cf_chl_opt\s*=/
const GOOGLE_RETRY_PATH = '/httpservice/retry/enablejs'

function isWidget(tag: string, attrs: Readonly<Record<string, string>>): boolean {
  return tag === 'altcha-widget' || WIDGET.test(attrs.id ?? '') || WIDGET.test(attrs.class ?? '')
}

function classifyElement(tag: string, attrs: Readonly<Record<string, string>>): ChallengeKind | undefined {
  if (isWidget(tag, attrs)) return 'challenge'
  let target: string | undefined
  if (tag === 'script') target = attrs.src
  else if (tag === 'form') target = attrs.action
  else if (tag === 'a') target = attrs.href
  else if (tag === 'meta' && attrs['http-equiv']?.toLowerCase() === 'refresh') {
    target = attrs.content?.match(/;\s*url\s*=\s*["']?([^"']+?)["']?\s*$/i)?.[1]
  }
  if (target === undefined) return undefined
  const url = URL.parse(target, 'https://search.invalid')
  if (url === null) return undefined
  if (tag === 'form' && url.pathname === '/anomaly.js') return 'challenge'
  if (tag === 'script' && (
    url.hostname === 'perimeterx.net' || url.hostname.endsWith('.perimeterx.net')
    || url.pathname.startsWith('/cdn-cgi/challenge-platform/')
  )) return 'challenge'
  if (url.pathname === GOOGLE_RETRY_PATH) return 'javascript'
  return undefined
}

/**
 * Classify recognized challenge markup without interpreting echoed query text.
 * @param html Search response HTML.
 * @returns The challenge kind, or `undefined` when no structural evidence exists.
 */
export function classifyChallengePage(html: string): ChallengeKind | undefined {
  let bootstrap = false
  const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(
    RAW_TEXT,
    (_match: string, name: string, attributes: string, body: string) => {
      if (name.toLowerCase() !== 'script') return ''
      if (CLOUDFLARE_BOOTSTRAP.test(body)) {
        const type = parseAttrs(attributes).type?.toLowerCase()
        if (type === undefined || type === 'text/javascript' || type === 'application/javascript' || type === 'module') bootstrap = true
      }
      return `<script${attributes}></script>`
    },
  )
  if (bootstrap) return 'challenge'
  let result: ChallengeKind | undefined
  for (const { tag, attrs } of scanTags(markup, (tag, attrs) =>
    tag === 'script' || tag === 'form' || tag === 'meta' || tag === 'a' || isWidget(tag, attrs))) {
    const kind = classifyElement(tag, attrs)
    if (kind === 'challenge') return kind
    if (kind !== undefined) result = kind
  }
  return result
}
