/**
 * Provider-level tests: fan-out semantics (all engines queried concurrently,
 * consensus merge with engine-order tiebreak), deadline behavior (return at
 * soft deadline with success, wait past soft for the first success, hard cap
 * with zero successes), straggler abort, aggregate failure, abort handling,
 * availability, and a full plugin boot against a stubbed fetch.
 * @module @hy-sde-org/dsh-web-search-public/tests/public
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import * as publicPlugin from '../src/index.ts'
import { PUBLIC_PROVIDER_ID, PublicSearchProvider } from '../src/provider.ts'
import type { PublicEngine, PublicEngineId } from '../src/types.ts'

const startpageHome = [
  '<form>',
  '<input type="hidden" name="sc" value="tok">',
  '<input name="lifetime" value="x">',
  '</form>',
].join('')

const startpageResults = [
  '<div class="result">',
  '  <a class="result-title result-link" href="https://startpage.test/a">Startpage A</a>',
  '  <p class="description">First description here.</p>',
  '</div>',
  '<div class="result">',
  '  <a class="result-title result-link" href="https://startpage.test/b">Startpage B</a>',
  '  <p class="description">Second description.</p>',
  '</div>',
].join('')

const ddgPage = [
  '<div class="result">',
  '  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs&amp;rut=1">Example Docs</a>',
  '  <div class="result__snippet">Everything about <b>examples</b>.</div>',
  '</div>',
  '<div class="result">',
  '  <a rel="nofollow" class="result__a" href="https://plain.test/page">Plain Result</a>',
  '  <a rel="nofollow" class="result__snippet">A plain snippet.</a>',
  '</div>',
].join('')

interface StubOptions {
  sources?: WebSearchSource[]
  error?: Error
  delayMs?: number
}

function stubEngine(id: PublicEngineId, options: StubOptions = {}): { engine: PublicEngine; calls: number[] } {
  const calls: number[] = []
  const engine: PublicEngine = {
    id,
    async search(_request: WebSearchRequest, _signal?: AbortSignal): Promise<WebSearchSource[]> {
      calls.push(1)
      if (options.delayMs !== undefined) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (options.error !== undefined) throw options.error
      return options.sources ?? []
    },
  }
  return { engine, calls }
}

type ProviderOverrides = Partial<{ timeoutMs: number; softDeadlineMs: number; hardDeadlineMs: number }>

function provider(engines: PublicEngine[], overrides: ProviderOverrides = {}): PublicSearchProvider {
  return new PublicSearchProvider({ engines, timeoutMs: 10_000, softDeadlineMs: 5_000, hardDeadlineMs: 30_000, ...overrides })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PublicSearchProvider', () => {
  it('is available when engines exist and unavailable otherwise', () => {
    const one = stubEngine('duckduckgo', { sources: [] })
    expect(provider([one.engine]).available()).toBe(true)
    expect(provider([]).available()).toBe(false)
  })

  it('fans out to every engine and returns the consensus merge', async () => {
    const startpage = stubEngine('startpage', {
      sources: [
        { url: 'https://example.com/shared', title: 'Shared (startpage)', snippet: 'short' },
        { url: 'https://a.example/one', title: 'Alpha', snippet: 'alpha snippet' },
      ],
    })
    const ddg = stubEngine('duckduckgo', {
      sources: [
        { url: 'https://www.example.com/shared/', title: 'Shared (ddg)', snippet: 'a much longer consolidated snippet' },
        { url: 'https://c.example/three', title: 'Gamma', snippet: 'gamma snippet' },
      ],
    })
    const result = await provider([startpage.engine, ddg.engine]).search({ query: 'q', maxResults: 3 })

    // Both engines were queried concurrently.
    expect(startpage.calls).toHaveLength(1)
    expect(ddg.calls).toHaveLength(1)
    expect(result).toEqual({
      sources: [
        // Two-engine consensus outranks single-engine results; the
        // www/trailing-slash variant merges. Startpage is earlier in the order,
        // so it wins the equal-rank title/url tie; the longer snippet wins.
        { url: 'https://example.com/shared', title: 'Shared (startpage)', snippet: 'a much longer consolidated snippet' },
        // Rank-1 single-engine results tie; the earlier engine's insertion
        // order wins.
        { url: 'https://a.example/one', title: 'Alpha', snippet: 'alpha snippet' },
        { url: 'https://c.example/three', title: 'Gamma', snippet: 'gamma snippet' },
      ],
      truncated: false,
    })
  })

  it('keeps each engine result when engines do not overlap and caps to maxResults', async () => {
    const first = stubEngine('startpage', { sources: [{ url: 'https://s.test/1', title: 'S One' }] })
    const second = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/2', title: 'D Two' }] })
    const result = await provider([first.engine, second.engine]).search({ query: 'q', maxResults: 1 })
    // No consensus anywhere: ties break on best rank then engine order, and the
    // provider caps the merged list to maxResults before returning.
    expect(result.sources).toEqual([{ url: 'https://s.test/1', title: 'S One' }])
  })

  it('tolerates individual engine failures and returns the surviving results', async () => {
    const blocked = stubEngine('startpage', { error: new Error('HTTP 403') })
    const healthy = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/3', title: 'Alpha' }] })
    const result = await provider([blocked.engine, healthy.engine]).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://d.test/3', title: 'Alpha' }])
  })

  it('waits past the soft deadline for the first success instead of returning empty', async () => {
    const slow = stubEngine('startpage', { sources: [{ url: 'https://s.test/1' }], delayMs: 60 })
    const empty = stubEngine('duckduckgo', { sources: [] })
    const result = await provider([slow.engine, empty.engine], { softDeadlineMs: 10, hardDeadlineMs: 200 }).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://s.test/1' }])
  })

  it('returns at the soft deadline with delivered results and aborts stragglers', async () => {
    const quick = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/4' }] })
    let stragglerAborted = false
    const hanging: PublicEngine = {
      id: 'startpage',
      async search(_request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { resolve() }, 1000)
          signal?.addEventListener('abort', () => { stragglerAborted = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return []
      },
    }
    const start = Date.now()
    const result = await provider([hanging, quick.engine], { softDeadlineMs: 50, hardDeadlineMs: 1000 }).search({ query: 'q' })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(500)
    expect(result.sources).toEqual([{ url: 'https://d.test/4' }])
    expect(stragglerAborted).toBe(true)
  })

  it('returns whatever it has at the hard deadline even with zero successes', async () => {
    const empty = stubEngine('duckduckgo', { sources: [] })
    const hanging: PublicEngine = {
      id: 'startpage',
      async search(): Promise<WebSearchSource[]> {
        return new Promise(() => {}) // never settles, ignores abort
      },
    }
    const result = await provider([hanging, empty.engine], { softDeadlineMs: 10, hardDeadlineMs: 40 }).search({ query: 'q' })
    // Only `empty` settled with no results — not all engines failed (one is
    // still in flight), so the aggregate returns what it has rather than
    // throwing.
    expect(result.sources).toEqual([])
  })

  it('aggregates failures into a WEB_PROVIDER_ERROR when every engine fails', async () => {
    const first = stubEngine('startpage', { error: new Error('HTTP 403') })
    const second = stubEngine('mojeek', { sources: [] })
    const result = provider([first.engine, second.engine]).search({ query: 'q' })
    await expect(result).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(result.catch((error: unknown) => error)).resolves.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'all public search engines failed: startpage: HTTP 403; mojeek: no results',
    })
  })

  it('throws WEB_PROVIDER_UNAVAILABLE when no engines are configured', async () => {
    await expect(provider([]).search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
  })

  it('throws WEB_ABORTED when the caller abort signal already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(provider([stubEngine('mojeek', { sources: [{ url: 'https://m.test/5' }] }).engine]).search(
      { query: 'q' },
      controller.signal,
    )).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('propagates WEB_ABORTED when the caller aborts mid-flight', async () => {
    const slow = stubEngine('startpage', { sources: [{ url: 'https://s.test/1' }], delayMs: 100 })
    const controller = new AbortController()
    const pending = provider([slow.engine, stubEngine('mojeek', { sources: [{ url: 'https://m.test/6' }] }).engine])
      .search({ query: 'q' }, controller.signal)
    setTimeout(() => { controller.abort() }, 10)
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await vi.waitFor(() => { expect(slow.calls.length).toBe(1) })
  })
})

describe('plugin boot', () => {
  // Per-URL routing: Startpage's homepage/serp and DuckDuckGo's html endpoint
  // each answer with their own fixture; anything else fails the test loudly.
  // The fan-out queries every engine, so non-startpage hosts must still answer
  // predictably or be tolerated as engine failures.
  function routerFixture(): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: unknown) => {
      const url = String((input as { url?: string }).url ?? input)
      let body: string
      if (url.includes('startpage.com/sp/search')) {
        body = startpageResults
      } else if (url.includes('startpage.com')) {
        body = startpageHome
      } else if (url.includes('html.duckduckgo.com')) {
        body = ddgPage
      } else if (url.includes('ecosia.org') || url.includes('google.com') || url.includes('mojeek.com')) {
        // Bot-challenged pages parse to zero results; the fan-out tolerates them.
        body = '<html><body>empty</body></html>'
      } else {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in publicPlugin).toBe(false)
  })

  it('registers the public provider and searches through ctx.web via the fan-out', async () => {
    const fetchMock = routerFixture()
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PUBLIC_PROVIDER_ID })
    const fiber = await ctx.plugin(publicPlugin, { softDeadlineMs: 500 })
    const result = await ctx.web.search({ query: 'example', maxResults: 5 })

    expect(result.truncated).toBe(false)
    // The fan-out merged Startpage's 2 results with DuckDuckGo's 2 (no URL
    // overlap, so all tie at rank 0 and engine order wins).
    expect(result.sources).toHaveLength(4)
    // Startpage answered (homepage handshake + POST search). DuckDuckGo was
    // queried too — every engine is fanned out in parallel.
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('startpage.com/sp/search'))).toBe(true)
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('html.duckduckgo.com'))).toBe(true)
    expect(result.sources[0]).toMatchObject({
      url: 'https://startpage.test/a',
      title: 'Startpage A',
      snippet: 'First description here.',
    })
    await fiber.dispose()
  })

  it('prefers the configured provider over the deepseek default', async () => {
    const fetchMock = routerFixture()
    vi.stubGlobal('fetch', fetchMock)
    process.env.DSH_WEB_SEARCH_PROVIDER = 'deepseek-official'

    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PUBLIC_PROVIDER_ID })
    const fiber = await ctx.plugin(publicPlugin, { softDeadlineMs: 500 })
    const result = await ctx.web.search({ query: 'example', maxResults: 2 })
    expect(result.sources.length).toBeGreaterThan(0)
    // The public provider was selected, so Startpage was contacted.
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('startpage.com'))).toBe(true)
    await fiber.dispose()
    delete process.env.DSH_WEB_SEARCH_PROVIDER
  })
})
