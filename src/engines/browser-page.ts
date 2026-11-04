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
 * and is optional: without one the engine simply stays fetch-only, so this
 * package keeps zero hard dependency on it.
 *
 * Redirect policy is per-transport and honest about it: the plain-fetch leg
 * uses `redirect: 'error'`, so a redirect is rejected before any `Location`
 * target is contacted (it escalates to the browser where one is mounted — the
 * browser then navigates like a real browser and follows redirects). A caller
 * abort is terminal: an aborted fetch never escalates, and an abort observed
 * at any step surfaces as a canceled {@link EngineSearchFailure}. Every
 * terminal outcome is structured — challenge walls and clean non-2xx pages
 * throw instead of returning a page the caller would parse as "no results".
 * @module @hy-sde-org/dsh-web-search-public/engines/browser-page
 */

import { EngineSearchFailure } from '../types.ts'
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

/**
 * Thrown by a lazy {@link PageScraper} when the host browser service is not
 * mounted at call time. {@link browserFetch} translates it into the failure
 * the escalation trigger warrants: a challenge/status trigger becomes a
 * `challenge`/`http` {@link EngineSearchFailure}; a network-failure trigger
 * re-surfaces the original error so a transient transport problem is not
 * misclassified as a challenge.
 */
export class BrowserUnavailableError extends Error {
  constructor(message = 'browser escalation unavailable: the browser service is not mounted') {
    super(message)
    this.name = 'BrowserUnavailableError'
  }
}

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

/** Abort-aware delay: rejects as canceled when the signal fires mid-wait. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineSearchFailure('canceled', 'aborted by caller'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new EngineSearchFailure('canceled', 'aborted by caller'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function fetchHtmlPage(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
  const headers: Record<string, string> = {
    ...buildBrowserNavigationHeaders(options.userAgent),
    ...(options.referer !== undefined
      ? { Referer: options.referer, 'Sec-Fetch-Site': 'same-origin' }
      : {}),
    ...options.headers,
  }
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      headers,
      redirect: 'error',
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } catch (error) {
    // `redirect: 'error'` rejects a redirect response as TypeError before any
    // Location target is contacted, and undici reports network-level failures
    // as TypeError too — both are retryable transport problems.
    if (error instanceof TypeError) {
      throw new EngineSearchFailure('transport', `redirect rejected or network failure: ${error.message}`)
    }
    throw error
  }
  return { html: await response.text(), status: response.status, url: response.url || url }
}

/**
 * Run the browser escalation attempts. `onUnavailable` converts a
 * {@link BrowserUnavailableError} from the scraper into the failure the
 * original escalation trigger warrants (never returns).
 */
async function browseHtmlPage(
  url: string,
  fallback: BrowserFallbackOptions,
  pageTimeoutMs: number,
  signal: AbortSignal | undefined,
  onUnavailable: () => never,
): Promise<LoadedHtmlPage> {
  const attempts = Math.max(1, fallback.attempts ?? 1)
  const retryDelayMs = fallback.retryDelayMs ?? 0

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // The retry wait is abort-aware: an abort during the delay rejects before
    // another scrape can start.
    if (attempt > 0 && retryDelayMs > 0) await delay(retryDelayMs, signal)
    // Caller cancellation is terminal: never start (or continue) a browser
    // navigation for an already-aborted search.
    if (signal?.aborted) throw new EngineSearchFailure('canceled', 'aborted by caller')
    let loaded: LoadedHtmlPage
    try {
      loaded = await fallback.scrape(url, {
        ...(fallback.homeUrl !== undefined ? { homeUrl: fallback.homeUrl } : {}),
        ...(fallback.ready !== undefined ? { ready: fallback.ready } : {}),
        ...(fallback.altcha !== undefined ? { altcha: fallback.altcha } : {}),
        timeoutMs: pageTimeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (error instanceof BrowserUnavailableError) onUnavailable()
      throw error
    }
    // A page that lands after the caller aborted is discarded, not parsed.
    if (signal?.aborted) throw new EngineSearchFailure('canceled', 'aborted by caller')
    if (!fallback.shouldFallback(loaded)) {
      if (loaded.status >= 200 && loaded.status < 300) return loaded
      // A clean non-2xx page from the browser navigation: no point retrying.
      throw new EngineSearchFailure('http', `HTTP ${loaded.status}`, loaded.status)
    }
    if (attempt === attempts - 1) {
      // The last attempt still classified as a challenge wall: surface a
      // structured failure instead of returning a page the caller would
      // parse as "no results".
      throw new EngineSearchFailure(
        'challenge',
        `browser search failed: every attempt answered with a challenge page (${url})`,
      )
    }
  }
  throw new EngineSearchFailure('challenge', 'browser search failed: every attempt answered with a challenge page')
}

/** Fetch with a browser profile; escalate rejected/challenged responses to the real browser. */
export async function browserFetch(url: string, options: BrowserFetchOptions): Promise<LoadedHtmlPage> {
  const fallback = options.browser
  let page: LoadedHtmlPage
  try {
    page = await fetchHtmlPage(url, options)
  } catch (error) {
    // Cancellation is terminal — an aborted fetch must never escalate.
    if (options.signal?.aborted) throw new EngineSearchFailure('canceled', 'aborted by caller')
    if (fallback === undefined || options.fetchImpl !== undefined) throw error
    return browseHtmlPage(url, fallback, options.pageTimeoutMs ?? BROWSER_PAGE_TIMEOUT_MS, options.signal, (): never => {
      // No browser to escalate a transport failure to: surface the original
      // error so it keeps its retryable-transport classification.
      throw error
    })
  }

  // A result that lands after the caller aborted is discarded, not parsed.
  if (options.signal?.aborted) throw new EngineSearchFailure('canceled', 'aborted by caller')
  if (fallback === undefined || options.fetchImpl !== undefined) {
    // No escalation available: a clean non-2xx page is a structured http
    // failure instead of a body the engines would parse (fetch-only engines
    // must not scrape a 503 response into "sources").
    if (!(page.status >= 200 && page.status < 300)) {
      throw new EngineSearchFailure('http', `HTTP ${page.status}`, page.status)
    }
    return page
  }
  const isSuccessful = page.status >= 200 && page.status < 300
  if (isSuccessful && !fallback.shouldFallback(page)) return page
  return browseHtmlPage(url, fallback, options.pageTimeoutMs ?? BROWSER_PAGE_TIMEOUT_MS, options.signal, (): never => {
    // The trigger was a status/challenge, so the missing browser turns it into
    // the structured failure it warrants (a 5xx stays `http`, not `challenge`).
    if (fallback.shouldFallback(page)) {
      throw new EngineSearchFailure(
        'challenge',
        `bot challenge (HTTP ${page.status}) and no browser service mounted to escalate`,
      )
    }
    throw new EngineSearchFailure('http', `HTTP ${page.status}`, page.status)
  })
}
