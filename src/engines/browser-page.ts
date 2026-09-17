/**
 * Browser-profiled fetch with stealth-browser escalation — a port of
 * oh-my-pi's `browser-page.ts` against the harness' own `ctx.browser` service.
 *
 * Path division of labor (same as omp): every engine first tries a plain
 * `fetch` carrying coherent navigation headers (`browser-headers.ts`); when
 * that fails, returns a non-2xx, or the body smells like a bot challenge
 * (Cloudflare firewall, ALTCHA wall, "unusual traffic", …), the engines that
 * are browser-backed escalate to a real (stealth-patched / CloakBrowser)
 * browser via the injected {@link PageScraper}. The scraper lives in the
 * browser host service (`BrowserService.fetchPageHtml`) — never the tool —
 * and is optional: without one the engine simply stays fetch-only (the
 * previous behavior), so this package keeps zero hard dependency on it.
 * @module @hy-sde-org/dsh-web-search-public/engines/browser-page
 */

import { buildBrowserNavigationHeaders } from './browser-headers.ts'

/** HTML plus the response status and final URL after redirects or browser navigation. */
export interface LoadedHtmlPage {
  html: string
  status: number
  url: string
}

/**
 * One page load in a real browser: navigates (optionally seeding a home URL
 * first for cookies), optionally waits for a ready selector, and returns the
 * rendered HTML plus the navigation response status and final URL. The host
 * implementation is `BrowserService.fetchPageHtml` — structurally duck-typed
 * here so this package needs no import of the browser service types.
 */
export type PageScraper = (
  url: string,
  options: {
    homeUrl?: string
    ready?: { selector: string; timeoutMs: number }
    timeoutMs?: number
    signal?: AbortSignal
    /** Mojeek-style ALTCHA interstitial: click the widget checkbox, wait for PoW redirect. */
    altcha?: { resultsSelector: string; waitMs: number }
  },
) => Promise<LoadedHtmlPage>

/** Browser escalation configuration for one engine. */
export interface BrowserFallbackOptions {
  /** The real-browser page loader (host `ctx.browser.fetchPageHtml`). */
  readonly scrape: PageScraper
  /** Seed this homepage first so its cookies apply to the target navigation. */
  readonly homeUrl?: string
  /** Best-effort wait for the results list to render. */
  readonly ready?: { selector: string; timeoutMs: number }
  /** `true` when the loaded page is a challenge/bot wall (advance to browser or retry). */
  readonly shouldFallback: (page: LoadedHtmlPage) => boolean
  /** ALTCHA interstitial handling for this engine (click checkbox → wait for results). */
  readonly altcha?: { resultsSelector: string; waitMs: number }
  /** Retries inside the browser for page loads that still classify as blocked. Default: 1. */
  readonly attempts?: number
  /** Delay between browser retries (ms). */
  readonly retryDelayMs?: number
}

/** Controls a browser-profiled fetch and its optional browser fallback. */
export interface BrowserFetchOptions {
  /** Agent identity — coherent headers are derived from it. */
  readonly userAgent: string
  readonly signal?: AbortSignal
  /** Plain-fetch transport bound (ms); the fan-out's engine timeout also applies. */
  readonly timeoutMs?: number
  /** Browser navigation bound (ms) per `goto`. Default: {@link BROWSER_PAGE_TIMEOUT_MS}. */
  readonly pageTimeoutMs?: number
  readonly referer?: string
  /** Extra headers merged over the navigation set (e.g. cookie seeding). */
  readonly headers?: Readonly<Record<string, string>>
  /** Escalation config; absent = fetch-only. */
  readonly browser?: BrowserFallbackOptions
  /** Test seam: an injected fetch never escalates (mirrors omp's `fetch` option). */
  readonly fetchImpl?: typeof fetch
}

/** Default per-`goto` bound for the browser fallback (below the 60 s tool budget). */
export const BROWSER_PAGE_TIMEOUT_MS = 30_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchHtmlPage(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
  const headers: Record<string, string> = {
    ...buildBrowserNavigationHeaders(options.userAgent),
    ...(options.referer !== undefined
      ? { Referer: options.referer, 'Sec-Fetch-Site': 'same-origin' }
      : {}),
    ...options.headers,
  }
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  return { html: await response.text(), status: response.status, url: response.url || url }
}

async function browseHtmlPage(
  url: string,
  fallback: BrowserFallbackOptions,
  pageTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<LoadedHtmlPage> {
  const attempts = Math.max(1, fallback.attempts ?? 1)
  const retryDelayMs = fallback.retryDelayMs ?? 0

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && retryDelayMs > 0) await delay(retryDelayMs)
    const loaded = await fallback.scrape(url, {
      ...(fallback.homeUrl !== undefined ? { homeUrl: fallback.homeUrl } : {}),
      ...(fallback.ready !== undefined ? { ready: fallback.ready } : {}),
      ...(fallback.altcha !== undefined ? { altcha: fallback.altcha } : {}),
      timeoutMs: pageTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!fallback.shouldFallback(loaded) || attempt === attempts - 1) return loaded
  }
  throw new Error('browser search failed: every attempt answered with a challenge page')
}

/** Fetch with a browser profile; escalate rejected/challenged responses to the real browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
  const fallback = options.browser
  let page: LoadedHtmlPage
  try {
    page = await fetchHtmlPage(url, options)
  } catch (error) {
    if (fallback === undefined || options.fetchImpl !== undefined) throw error
    return browseHtmlPage(url, fallback, options.pageTimeoutMs ?? BROWSER_PAGE_TIMEOUT_MS, options.signal)
  }

  if (fallback === undefined || options.fetchImpl !== undefined) return page
  const isSuccessful = page.status >= 200 && page.status < 300
  if (isSuccessful && !fallback.shouldFallback(page)) return page
  return browseHtmlPage(url, fallback, options.pageTimeoutMs ?? BROWSER_PAGE_TIMEOUT_MS, options.signal)
}
