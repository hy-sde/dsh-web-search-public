/**
 * Provider-level tests: chain semantics (first-success, advance on failure /
 * zero results / timeout), aggregate failure, abort handling, availability,
 * and a full plugin boot against a stubbed fetch.
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

function provider(engines: PublicEngine[], timeoutMs = 10_000): PublicSearchProvider {
  return new PublicSearchProvider({ engines, timeoutMs })
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

  it('returns the first engine with results and stops there', async () => {
    const first = stubEngine('startpage', { sources: [{ url: 'https://s.test/1', title: 'S One' }] })
    const second = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/1' }] })
    const result = await provider([first.engine, second.engine]).search({ query: 'q', maxResults: 3 })
    expect(result).toEqual({ sources: [{ url: 'https://s.test/1', title: 'S One' }], truncated: false })
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
  })

  it('advances on empty results', async () => {
    const first = stubEngine('startpage', { sources: [] })
    const second = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/2' }] })
    const result = await provider([first.engine, second.engine]).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://d.test/2' }])
  })

  it('advances on engine failure', async () => {
    const first = stubEngine('startpage', { error: new Error('HTTP 403') })
    const second = stubEngine('google', { sources: [{ url: 'https://g.test/3' }] })
    const result = await provider([first.engine, second.engine]).search({ query: 'q' })
    expect(result.sources).toEqual([{ url: 'https://g.test/3' }])
  })

  it('advances on per-engine timeout even when the engine ignores the signal', async () => {
    const hanging = stubEngine('ecosia', { sources: [{ url: 'https://e.test/x' }], delayMs: 400 })
    const fallback = stubEngine('mojeek', { sources: [{ url: 'https://m.test/4' }] })
    const start = Date.now()
    const result = await provider([hanging.engine, fallback.engine], 60).search({ query: 'q' })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(350)
    expect(result.sources).toEqual([{ url: 'https://m.test/4' }])
  })

  it('aggregates failures into a WEB_PROVIDER_ERROR', async () => {
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

  it('propagates WEB_ABORTED when the caller aborts mid-chain', async () => {
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
      } else {
        throw new Error(`unexpected fetch: ${url}`)
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in publicPlugin).toBe(false)
  })

  it('registers the public provider and searches through ctx.web via the first engine', async () => {
    const fetchMock = routerFixture()
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PUBLIC_PROVIDER_ID })
    const fiber = await ctx.plugin(publicPlugin, { timeoutMs: 1000 })
    const result = await ctx.web.search({ query: 'example', maxResults: 5 })

    expect(result.truncated).toBe(false)
    expect(result.sources).toHaveLength(2)
    expect(result.sources[0]).toMatchObject({
      url: 'https://startpage.test/a',
      title: 'Startpage A',
      snippet: 'First description here.',
    })
    // Startpage is first: homepage (hidden fields) + POST search, then stop —
    // never DuckDuckGo or later engines.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain('startpage.com')
    }
    await fiber.dispose()
  })

  it('prefers the configured provider over the deepseek default', async () => {
    const fetchMock = routerFixture()
    vi.stubGlobal('fetch', fetchMock)
    process.env.DSH_WEB_SEARCH_PROVIDER = 'deepseek-official'

    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: PUBLIC_PROVIDER_ID })
    const fiber = await ctx.plugin(publicPlugin)
    const result = await ctx.web.search({ query: 'example', maxResults: 2 })
    expect(result.sources.length).toBeGreaterThan(0)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('startpage.com')
    await fiber.dispose()
    delete process.env.DSH_WEB_SEARCH_PROVIDER
  })
})
