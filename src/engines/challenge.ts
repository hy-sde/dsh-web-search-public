/**
 * Challenge detection harmonized with the upstream harness fork's
 * anti-false-positive rule (`@deepseek-ai/dsh-web` `scanChallengePage`),
 * keeping this package's stronger structural DOM detectors on top.
 *
 * Evidence tiers, first match wins:
 * 1. A `cf-mitigated: challenge` response header — trusted on ANY status.
 * 2. A live `<input name="js_challenge">` form field — trusted on ANY status,
 *    size-gated (see {@link CHALLENGE_PAGE_MAX_CHARS}).
 * 3. Vendor text markers (`_cf_chl_opt`, `captcha-delivery.com`, `px-captcha`,
 *    "blocked by network security") — trusted ONLY on non-2xx responses,
 *    because on a 2xx page those strings also appear in ordinary articles that
 *    quote them (or embed a widget carrying their name).
 * 4. This package's structural DOM detectors (widgets, challenge scripts,
 *    anomaly forms, retry navigations) — trusted on ANY status; the engine
 *    chains additionally require zero organic results before failing a page,
 *    which keeps a 2xx results page that merely echoes query text accepted.
 *
 * The form check is size-gated because a challenge interstitial carries no
 * content — a larger page is a real document, not a wall. Only HTML content
 * types are scanned when the content type is known; `undefined` means the
 * caller could not know (browser-rendered payloads are HTML by construction).
 * @module @hy-sde-org/dsh-web-search-public/engines/challenge
 */

import { parseAttrs, scanTags } from './html.ts'

type ChallengeKind = 'javascript' | 'challenge'

/** Where a challenge verdict's evidence came from. */
export type ChallengeSource = 'cf-mitigated-header' | 'challenge-form' | 'page-marker' | 'dom-marker'

/** A named challenge classification: which protection and what evidence. */
export interface ChallengeVerdict {
  readonly protection: string
  readonly source: ChallengeSource
}

/** Status/header-aware input for the harmonized scan. */
export interface ChallengePageInput {
  readonly status: number
  readonly body: string
  /** `cf-mitigated` header: `null` when absent, `undefined` when unknown. */
  readonly cfMitigated?: string | null
  /** `content-type` header: `null` when absent, `undefined` when unknown. */
  readonly contentType?: string | null
}

/** A fetched/loaded page (`html` field) as accepted by {@link challengePageInput}. */
interface PageLike {
  readonly html: string
  readonly status: number
  readonly cfMitigated?: string | null
  readonly contentType?: string | null
}

/** Bodies larger than this skip the live-form check (a real document, not an interstitial). */
export const CHALLENGE_PAGE_MAX_CHARS = 64 * 1024

const WIDGET = /(?:^|\s)(?:px-captcha|captcha-wrap|altcha-widget|g-recaptcha|cf-turnstile|cf-chl(?:-[^\s]+)?|anomaly-modal__modal)(?:\s|$)/i
const RAW_TEXT = /<(script|style|textarea|title|template)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)(?:<\/\1\s*>|$)/gi
const CLOUDFLARE_BOOTSTRAP = /^\s*(?:\(\s*function\s*\(\s*\)\s*\{\s*)?window\._cf_chl_opt\s*=/
const GOOGLE_RETRY_PATH = '/httpservice/retry/enablejs'

/** Vendor text markers trusted only on non-2xx responses, in first-match order. */
const PAGE_MARKERS: readonly { text: string; protection: string }[] = [
  { text: '_cf_chl_opt', protection: 'Cloudflare' },
  { text: 'captcha-delivery.com', protection: 'DataDome' },
  { text: 'px-captcha', protection: 'PerimeterX' },
  { text: 'blocked by network security', protection: 'network security block' },
]

const CHALLENGE_FORM_FIELD = 'js_challenge'
/** Protection reported for structural evidence that names no vendor (generic wrapper classes). */
const GENERIC_CHALLENGE_PROTECTION = 'captcha wall'

/** Named widget evidence; id/class/tag matched against these patterns in order. */
const NAMED_WIDGETS: readonly { pattern: RegExp; protection: string }[] = [
  { pattern: /(?:^|\s)cf-turnstile(?:\s|$)/i, protection: 'Cloudflare' },
  { pattern: /(?:^|\s)cf-chl(?:-[^\s]+)?(?:\s|$)/i, protection: 'Cloudflare' },
  { pattern: /(?:^|\s)px-captcha(?:\s|$)/i, protection: 'PerimeterX' },
  { pattern: /(?:^|\s)altcha-widget(?:\s|$)/i, protection: 'ALTCHA' },
  { pattern: /(?:^|\s)g-recaptcha(?:\s|$)/i, protection: 'reCAPTCHA' },
  { pattern: /(?:^|\s)anomaly-modal__modal(?:\s|$)/i, protection: 'DuckDuckGo' },
]

const SOURCE_LABELS: Readonly<Record<ChallengeSource, string>> = {
  'cf-mitigated-header': 'cf-mitigated header',
  'challenge-form': 'challenge form',
  'page-marker': 'page marker',
  'dom-marker': 'page structure',
}

/**
 * Adapt a fetched or loaded page to a scan input, preserving the distinction
 * between a known-absent header (`null`, not scanned) and an unknown one
 * (`undefined`, scanned — browser-rendered payloads are HTML by construction).
 */
export function challengePageInput(page: PageLike): ChallengePageInput {
  return {
    status: page.status,
    body: page.html,
    ...(page.cfMitigated !== undefined ? { cfMitigated: page.cfMitigated } : {}),
    ...(page.contentType !== undefined ? { contentType: page.contentType } : {}),
  }
}

function isScannableHtml(contentType: string | null | undefined): boolean {
  if (contentType === undefined) return true
  return contentType !== null && contentType.toLowerCase().includes('html')
}

/** Remove comments and raw-text/template bodies; script tags stay (emptied) for src checks. */
function stripInertMarkup(html: string, onScriptBody?: (body: string, attributes: string) => void): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(
    RAW_TEXT,
    (_match: string, name: string, attributes: string, body: string) => {
      if (name.toLowerCase() !== 'script') return ''
      onScriptBody?.(body, attributes)
      return `<script${attributes}></script>`
    },
  )
}

/**
 * The fork's live-form check, implemented structurally: an `<input>` whose
 * (entity-decoded) `name` is `js_challenge`, outside comments and raw-text or
 * template bodies, in a body small enough to be an interstitial.
 */
function hasChallengeForm(body: string): boolean {
  if (body.length > CHALLENGE_PAGE_MAX_CHARS) return false
  const markup = stripInertMarkup(body)
  return scanTags(markup, (tag, attrs) => tag === 'input' && attrs.name === CHALLENGE_FORM_FIELD).length > 0
}

/**
 * The fork-harmonized anti-false-positive scan: response header, live
 * challenge form, then vendor text markers gated to non-2xx responses.
 * Structural DOM evidence is deliberately NOT part of this scan — engine
 * chains layer it separately (with a zero-results guard) via
 * {@link classifyChallengeResponse}.
 */
export function scanChallengePage(input: ChallengePageInput): ChallengeVerdict | undefined {
  if (!isScannableHtml(input.contentType)) return undefined
  if (input.cfMitigated?.toLowerCase() === 'challenge') {
    return { protection: 'Cloudflare', source: 'cf-mitigated-header' }
  }
  if (hasChallengeForm(input.body)) {
    return { protection: 'JavaScript challenge', source: 'challenge-form' }
  }
  if (input.status >= 200 && input.status < 300) return undefined
  for (const marker of PAGE_MARKERS) {
    if (input.body.includes(marker.text)) {
      return { protection: marker.protection, source: 'page-marker' }
    }
  }
  return undefined
}

interface DomEvidence {
  readonly kind: ChallengeKind
  readonly protection: string
}

function widgetProtection(tag: string, attrs: Readonly<Record<string, string>>): string {
  const value = `${tag} ${attrs.id ?? ''} ${attrs.class ?? ''}`
  for (const { pattern, protection } of NAMED_WIDGETS) {
    if (pattern.test(value)) return protection
  }
  return GENERIC_CHALLENGE_PROTECTION
}

function classifyElement(tag: string, attrs: Readonly<Record<string, string>>): DomEvidence | undefined {
  if (isWidget(tag, attrs)) return { kind: 'challenge', protection: widgetProtection(tag, attrs) }
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
  if (tag === 'form' && url.pathname === '/anomaly.js') return { kind: 'challenge', protection: 'DuckDuckGo' }
  if (tag === 'script') {
    if (url.hostname === 'perimeterx.net' || url.hostname.endsWith('.perimeterx.net')) {
      return { kind: 'challenge', protection: 'PerimeterX' }
    }
    if (url.pathname.startsWith('/cdn-cgi/challenge-platform/')) {
      return { kind: 'challenge', protection: 'Cloudflare' }
    }
  }
  if (url.pathname === GOOGLE_RETRY_PATH) return { kind: 'javascript', protection: 'JavaScript challenge' }
  return undefined
}

function isWidget(tag: string, attrs: Readonly<Record<string, string>>): boolean {
  return tag === 'altcha-widget' || WIDGET.test(attrs.id ?? '') || WIDGET.test(attrs.class ?? '')
}

function domEvidence(html: string): DomEvidence | undefined {
  let bootstrap = false
  const markup = stripInertMarkup(html, (body, attributes) => {
    if (!CLOUDFLARE_BOOTSTRAP.test(body)) return
    const type = parseAttrs(attributes).type?.toLowerCase()
    if (type === undefined || type === 'text/javascript' || type === 'application/javascript' || type === 'module') bootstrap = true
  })
  const challenge: DomEvidence[] = []
  let javascript: DomEvidence | undefined
  if (bootstrap) challenge.push({ kind: 'challenge', protection: 'Cloudflare' })
  for (const { tag, attrs } of scanTags(markup, (tag, attrs) =>
    tag === 'script' || tag === 'form' || tag === 'meta' || tag === 'a' || isWidget(tag, attrs))) {
    const evidence = classifyElement(tag, attrs)
    if (evidence === undefined) continue
    if (evidence.kind === 'challenge') challenge.push(evidence)
    else if (javascript === undefined) javascript = evidence
  }
  if (challenge.length === 0) return javascript
  // Prefer specifically named evidence over an earlier generic wrapper (an
  // ALTCHA widget inside a `captcha-wrap` div names ALTCHA, not the wrapper).
  return challenge.find(evidence => evidence.protection !== GENERIC_CHALLENGE_PROTECTION) ?? challenge[0]
}

function domVerdict(html: string): ChallengeVerdict | undefined {
  const evidence = domEvidence(html)
  return evidence === undefined ? undefined : { protection: evidence.protection, source: 'dom-marker' }
}

/**
 * Full classification for engine chains: the harmonized scan plus this
 * package's structural DOM detectors. Callers that parse results must gate
 * challenge failures on zero organic results (the engine contract).
 */
export function classifyChallengeResponse(input: ChallengePageInput): ChallengeVerdict | undefined {
  if (!isScannableHtml(input.contentType)) return undefined
  return scanChallengePage(input) ?? domVerdict(input.body)
}

/**
 * Classify recognized challenge markup without interpreting echoed query text.
 * @param html Search response HTML.
 * @returns The challenge kind, or `undefined` when no structural evidence exists.
 */
export function classifyChallengePage(html: string): ChallengeKind | undefined {
  return domEvidence(html)?.kind
}

/** Human-readable verdict for failure messages, e.g. `Cloudflare via page marker`. */
export function describeChallenge(verdict: ChallengeVerdict): string {
  return `${verdict.protection} via ${SOURCE_LABELS[verdict.source]}`
}
