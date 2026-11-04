/**
 * Unit tests for the browser-profiled transport (omp-ported escalation):
 * header coherence, fetch-first behavior, challenge/4xx escalation to the
 * injected page scraper, retry loops, fetch-only mode without a scraper, and
 * the structured terminal outcomes (canceled/transport/http/challenge) with
 * abort-guarded escalation.
 * @module @hy-sde-org/dsh-web-search-public/tests/browser
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserUnavailableError,
  browserFetch,
  BROWSER_PAGE_TIMEOUT_MS,
  type LoadedHtmlPage,
  type PageScraper,
} from '../src/engines/browser-page.ts'
import { buildBrowserNavigationHeaders } from '../src/engines/browser-headers.ts'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}

function fetchMock(): ReturnType<typeof vi.fn> {
  const fn = vi.fn()
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildBrowserNavigationHeaders', () => {
  it('derives coherent client hints from a Chrome user agent', () => {
    const headers = buildBrowserNavigationHeaders(UA)
    expect(headers['User-Agent']).toBe(UA)
    expect(headers['Sec-Ch-Ua']).toContain('"Google Chrome";v="126"')
    expect(headers['Sec-Ch-Ua-Mobile']).toBe('?0')
    expect(headers['Sec-Ch-Ua-Platform']).toBe('"macOS"')
    expect(headers['Sec-Fetch-Mode']).toBe('navigate')
    expect(headers['Sec-Fetch-Site']).toBe('none')
    expect(headers['Upgrade-Insecure-Requests']).toBe('1')
  })

  it('keeps the navigation shape for non-Chrome agents', () => {
    const headers = buildBrowserNavigationHeaders('Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0')
    expect(headers['Sec-Ch-Ua']).toBeUndefined()
    expect(headers['Sec-Fetch-Dest']).toBe('document')
    expect(headers['User-Agent']).toContain('Firefox/126.0')
  })
})

describe('browserFetch', () => {
  const SERP = '<div id="search"><a href="https://g.test/one"><h3>One</h3></a></div>'
  const blockedScraperCalls: string[] = []
  const challengeScraper: PageScraper = async (url) => {
    blockedScraperCalls.push(url)
    return { html: SERP, status: 200, url }
  }
  // Challenge walls don't carry the SERP markup: classify by content so a
  // rendered SERP counts as clean (the escalation must land a clean page).
  const notSerp = (page: LoadedHtmlPage): boolean => !page.html.includes('<div id="search">')

  it('returns the plain fetch page without touching the browser when clean', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(okResponse(SERP))
    const scrape = vi.fn()
    const page = await browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape, homeUrl: 'https://www.google.com/', shouldFallback: () => false },
    })
    expect(page.html).toBe(SERP)
    expect(page.status).toBe(200)
    expect(scrape).not.toHaveBeenCalled()
  })

  it('escalates a 403 to the browser scraper and returns the rendered page', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(new Response('sorry', { status: 403 }))
    const page = await browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape: challengeScraper, homeUrl: 'https://www.google.com/', shouldFallback: notSerp },
    })
    expect(page.html).toBe(SERP)
    expect(blockedScraperCalls).toEqual(['https://www.google.com/search?q=x'])
  })

  it('escalates a 200 challenge body (shouldFallback) and passes the referer on fetch', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(okResponse('<title>Enable JavaScript</title>'))
    const page = await browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      referer: 'https://www.google.com/',
      browser: { scrape: challengeScraper, shouldFallback: notSerp },
    })
    expect(page.html).toBe(SERP)
    const [, init] = fetch.mock.calls[0]!
    expect(init.headers.Referer).toBe('https://www.google.com/')
    expect(init.headers['Sec-Fetch-Site']).toBe('same-origin')
  })

  it('escalates a network failure (no injected fetch) to the browser', async () => {
    const fetch = fetchMock()
    fetch.mockRejectedValue(new Error('ECONNRESET'))
    const page = await browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape: challengeScraper, shouldFallback: notSerp },
    })
    expect(page.html).toBe(SERP)
  })

  it('retries inside the browser until a non-fallback page lands', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(okResponse('<div>altcha-widget</div>'))
    const attempts: LoadedHtmlPage[] = [
      { html: '<div>altcha-widget</div>', status: 200, url: 'https://www.mojeek.com/search?q=x' },
      { html: SERP, status: 200, url: 'https://www.mojeek.com/search?q=x' },
    ]
    const scrape = vi.fn(async () => attempts.shift()!)
    const page = await browserFetch('https://www.mojeek.com/search?q=x', {
      userAgent: UA,
      browser: {
        scrape,
        shouldFallback: candidate => candidate.html.includes('altcha-widget'),
        attempts: 2,
        retryDelayMs: 1,
      },
    })
    expect(page.html).toBe(SERP)
    expect(scrape).toHaveBeenCalledTimes(2)
  })

  it('rejects with a challenge failure when every browser attempt is blocked', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(okResponse('<div>problem</div>'))
    const scrape = vi.fn(async () => ({ html: '<div>altcha-widget</div>', status: 200, url: 'u' }))
    await expect(browserFetch('https://www.mojeek.com/search?q=x', {
      userAgent: UA,
      browser: { scrape, shouldFallback: () => true, attempts: 2, retryDelayMs: 1 },
    })).rejects.toThrow('browser search failed: every attempt answered with a challenge page')
    expect(scrape).toHaveBeenCalledTimes(2)
  })

  it('stays fetch-only (propagates the fetch error) when no browser escalation is configured', async () => {
    const fetch = fetchMock()
    fetch.mockRejectedValue(new Error('ECONNRESET'))
    await expect(browserFetch('https://www.ecosia.org/search?q=x', { userAgent: UA })).rejects.toThrow('ECONNRESET')
  })

  it('passes the default navigation bound to the scraper', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(okResponse('<div>problem</div>'))
    let seen: number | undefined
    const scrape: PageScraper = async (_url, options) => {
      seen = options?.timeoutMs
      return { html: SERP, status: 200, url: 'u' }
    }
    await browserFetch('https://www.ecosia.org/search?q=x', {
      userAgent: UA,
      browser: { scrape, shouldFallback: notSerp },
    })
    expect(seen).toBe(BROWSER_PAGE_TIMEOUT_MS)
  })

  it('never escalates an aborted fetch and discards a page that lands after abort', async () => {
    const fetch = fetchMock()
    fetch.mockRejectedValue(new Error('ECONNRESET'))
    const scrape = vi.fn(async () => ({ html: SERP, status: 200, url: 'u' }))
    const controller = new AbortController()
    controller.abort()
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      signal: controller.signal,
      browser: { scrape, shouldFallback: () => true },
    })).rejects.toThrow('aborted by caller')
    expect(scrape).not.toHaveBeenCalled()
    // A page that lands despite the abort is discarded, not parsed.
    fetch.mockResolvedValue(okResponse(SERP))
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      signal: controller.signal,
      browser: { scrape, shouldFallback: () => false },
    })).rejects.toThrow('aborted by caller')
  })

  it('re-surfaces the original transport error when the browser service is unavailable', async () => {
    const fetch = fetchMock()
    fetch.mockRejectedValue(new Error('ECONNRESET'))
    const scrape = vi.fn(async () => { throw new BrowserUnavailableError() })
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape, shouldFallback: () => true },
    })).rejects.toThrow('ECONNRESET')
    // A challenge/status trigger classifies as a challenge instead.
    fetch.mockResolvedValue(new Response('sorry', { status: 403 }))
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape, shouldFallback: () => true },
    })).rejects.toMatchObject({ kind: 'challenge' })
    expect(scrape).toHaveBeenCalledTimes(2)
  })

  it('throws an http failure for a clean non-2xx page from the browser navigation', async () => {
    const fetch = fetchMock()
    fetch.mockResolvedValue(new Response('down', { status: 503 }))
    const scrape = vi.fn(async () => ({ html: '<div>down</div>', status: 503, url: 'u' }))
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      browser: { scrape, shouldFallback: () => false },
    })).rejects.toMatchObject({ kind: 'http' })
  })

  it('classifies a rejected redirect as a retryable transport failure', async () => {
    const fetch = fetchMock()
    fetch.mockRejectedValue(new TypeError('Unexpected redirect'))
    await expect(browserFetch('https://www.google.com/search?q=x', { userAgent: UA }))
      .rejects.toMatchObject({ kind: 'transport' })
  })

  it('classifies a non-2xx page as an http failure when fetchImpl is injected (test seam)', async () => {
    await expect(browserFetch('https://www.google.com/search?q=x', {
      userAgent: UA,
      fetchImpl: (async () => new Response('sorry', { status: 403 })) as typeof fetch,
      browser: { scrape: challengeScraper, shouldFallback: () => true },
    })
    ).rejects.toMatchObject({ kind: 'http', status: 403 })
  })
})
