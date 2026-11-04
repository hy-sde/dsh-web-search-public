/**
 * Provider-level tests: fan-out semantics (all engines queried concurrently,
 * consensus merge with engine-order tiebreak and one vote per canonical URL
 * per engine), deadline behavior (return at the soft deadline with success,
 * wait past soft for the first success, hard cap with zero successes, an
 * overall deadline shared across retries), straggler abort, structured engine
 * outcomes (accepted empties vs HTTP/challenge/transport failures), aggregate
 * failure, per-engine circuit breaker (hard blocks and challenge walls trip,
 * backoff doubling and recovery), retry/cooldown policy, abort and disposal
 * draining, availability, and a full plugin boot against a stubbed fetch.
 * @module @hy-sde-org/dsh-web-search-public/tests/public
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'
import * as publicPlugin from '../src/index.ts'
import { PUBLIC_PROVIDER_ID, PublicSearchProvider } from '../src/provider.ts'
import { EngineSearchFailure, type PublicEngine, type PublicEngineId } from '../src/types.ts'

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

type ProviderOverrides = Partial<{
  timeoutMs: number
  softDeadlineMs: number
  hardDeadlineMs: number
  maxRetries: number
  retryDelayMs: number
  failureCooldownMs: number
  engineBackoffMs: number
  maxEngineBackoffMs: number
}>

function provider(engines: PublicEngine[], overrides: ProviderOverrides = {}): PublicSearchProvider {
  return new PublicSearchProvider({
    engines,
    timeoutMs: 10_000,
    softDeadlineMs: 5_000,
    hardDeadlineMs: 30_000,
    // Retries/cooldown are opt-in per test so the pre-existing aggregate-failure
    // expectations keep their single-attempt timing. The per-engine breaker is
    // on with a short base window so breaker tests stay fast.
    maxRetries: 0,
    retryDelayMs: 2_000,
    failureCooldownMs: 30_000,
    engineBackoffMs: 5_000,
    maxEngineBackoffMs: 20_000,
    ...overrides,
  })
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

  it('returns the full merged list and leaves truncation to the web seam', async () => {
    const first = stubEngine('startpage', { sources: [{ url: 'https://s.test/1', title: 'S One' }] })
    const second = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/2', title: 'D Two' }] })
    const result = await provider([first.engine, second.engine]).search({ query: 'q', maxResults: 1 })
    // No consensus anywhere: ties break on best rank then engine order. The
    // provider returns the full merged list truncated:false — the web seam
    // caps it to the request's maxResults and sets truncated:true itself.
    expect(result).toEqual({
      sources: [
        { url: 'https://s.test/1', title: 'S One' },
        { url: 'https://d.test/2', title: 'D Two' },
      ],
      truncated: false,
    })
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
    // `empty` accepted the search and legitimately found nothing — an accepted
    // empty page, not a failure — while the other engine never settled, so the
    // aggregate returns what it has rather than throwing.
    expect(result.sources).toEqual([])
  })

  it('aggregates failures into a WEB_PROVIDER_ERROR when every engine fails', async () => {
    const first = stubEngine('startpage', { error: new Error('HTTP 403') })
    const second = stubEngine('mojeek', { error: new Error('HTTP 502') })
    const result = provider([first.engine, second.engine]).search({ query: 'q' })
    await expect(result).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(result.catch((error: unknown) => error)).resolves.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'all public search engines failed: startpage: HTTP 403; mojeek: HTTP 502',
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

  it('retries the fan-out after an all-failed HTTP 5xx burst and recovers', async () => {
    let calls = 0
    const flaky: PublicEngine = {
      id: 'mojeek',
      async search(): Promise<WebSearchSource[]> {
        calls += 1
        if (calls === 1) throw new Error('HTTP 502')
        return [{ url: 'https://m.test/7', title: 'Recovered' }]
      },
    }
    const result = await provider([flaky], { maxRetries: 1, retryDelayMs: 5 }).search({ query: 'q' })
    expect(calls).toBe(2)
    expect(result.sources).toEqual([{ url: 'https://m.test/7', title: 'Recovered' }])
  })

  it('retries when every engine dies on a network-level fetch failure', async () => {
    let calls = 0
    const flaky: PublicEngine = {
      id: 'duckduckgo',
      async search(): Promise<WebSearchSource[]> {
        calls += 1
        if (calls === 1) throw new Error('fetch failed')
        return [{ url: 'https://d.test/8', title: 'Back online' }]
      },
    }
    const result = await provider([flaky], { maxRetries: 1, retryDelayMs: 5 }).search({ query: 'q' })
    expect(calls).toBe(2)
    expect(result.sources).toEqual([{ url: 'https://d.test/8', title: 'Back online' }])
  })

  it('does not retry an HTTP 4xx hard block and fast-fails inside the cooldown window', async () => {
    const blocked = stubEngine('mojeek', { error: new Error('HTTP 403') })
    const subject = provider([blocked.engine], {
      maxRetries: 3,
      retryDelayMs: 2,
      failureCooldownMs: 100,
      engineBackoffMs: 50,
    })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'all public search engines failed: mojeek: HTTP 403',
    })
    expect(blocked.calls).toHaveLength(1) // 4xx is never retried
    // The second call sits inside the aggregate cooldown: it fails fast with a
    // clear rate-limit message and does not touch the engines again.
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /rate limited/,
    })
    expect(blocked.calls).toHaveLength(1)
    // Past the cooldown and the breaker window a normal search resumes (and
    // hard-blocks again).
    await new Promise(resolve => setTimeout(resolve, 150))
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(blocked.calls).toHaveLength(2)
  })

  it('returns [] without retrying when every engine accepts the search with zero results', async () => {
    const empty = stubEngine('mojeek', { sources: [] })
    const subject = provider([empty.engine], { maxRetries: 3, retryDelayMs: 2, failureCooldownMs: 100 })
    const result = await subject.search({ query: 'gibberish' })
    // An accepted page with zero organic results is a legitimate empty answer,
    // not an engine failure — no retry, no breaker trip, no cooldown.
    expect(result).toEqual({ sources: [], truncated: false })
    expect(empty.calls).toHaveLength(1)
    const again = await subject.search({ query: 'other' })
    expect(again.sources).toEqual([])
    expect(empty.calls).toHaveLength(2)
  })

  it('aborts promptly while sleeping through the retry backoff', async () => {
    const flaky = stubEngine('mojeek', { error: new Error('fetch failed') })
    const controller = new AbortController()
    const pending = provider([flaky.engine], { maxRetries: 1, retryDelayMs: 10_000 })
      .search({ query: 'q' }, controller.signal)
    setTimeout(() => { controller.abort() }, 5)
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(flaky.calls).toHaveLength(1)
  })

  it('skips a hard-blocked engine on later searches instead of re-blasting it', async () => {
    const blocked = stubEngine('ecosia', { error: new Error('HTTP 403') })
    const healthy = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/9', title: 'Healthy' }] })
    const subject = provider([blocked.engine, healthy.engine], { engineBackoffMs: 5_000 })
    const first = await subject.search({ query: 'q' })
    expect(first.sources).toEqual([{ url: 'https://d.test/9', title: 'Healthy' }])
    expect(blocked.calls).toHaveLength(1)
    const second = await subject.search({ query: 'q' })
    expect(second.sources).toEqual([{ url: 'https://d.test/9', title: 'Healthy' }])
    // The breaker is open: the engine was skipped without a network request.
    expect(blocked.calls).toHaveLength(1)
    expect(healthy.calls).toHaveLength(2)
  })

  it('trips a challenge-walled engine and stops querying it', async () => {
    const walled = stubEngine('duckduckgo', {
      error: new EngineSearchFailure('challenge', 'bot challenge (HTTP 403) and no browser service mounted to escalate'),
    })
    const healthy = stubEngine('startpage', { sources: [{ url: 'https://s.test/10', title: 'Alive' }] })
    const subject = provider([walled.engine, healthy.engine], { engineBackoffMs: 5_000 })
    const first = await subject.search({ query: 'q' })
    expect(first.sources).toEqual([{ url: 'https://s.test/10', title: 'Alive' }])
    expect(walled.calls).toHaveLength(1)
    const second = await subject.search({ query: 'q' })
    expect(second.sources).toEqual([{ url: 'https://s.test/10', title: 'Alive' }])
    // The challenge classified as a hard block: the breaker is open, the
    // engine is skipped without another request.
    expect(walled.calls).toHaveLength(1)
    expect(healthy.calls).toHaveLength(2)
  })

  it('probes a tripped engine after the backoff and resets the window on success', async () => {
    let calls = 0
    const flaky: PublicEngine = {
      id: 'mojeek',
      async search(): Promise<WebSearchSource[]> {
        calls += 1
        if (calls === 1 || calls === 3) throw new Error('HTTP 403')
        return [{ url: 'https://m.test/11', title: 'Recovered' }]
      },
    }
    const subject = provider([flaky], { failureCooldownMs: 0, engineBackoffMs: 50, maxEngineBackoffMs: 200 })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(calls).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 60)) // past the 50ms breaker
    const result = await subject.search({ query: 'q' }) // probe succeeds
    expect(calls).toBe(2)
    expect(result.sources).toEqual([{ url: 'https://m.test/11', title: 'Recovered' }])
    // A later failure after recovery starts at the BASE window again (50ms,
    // not the doubled 100ms), so this probe is not skipped.
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(calls).toBe(3)
    await new Promise(resolve => setTimeout(resolve, 60))
    const again = await subject.search({ query: 'q' })
    expect(again.sources).toEqual([{ url: 'https://m.test/11', title: 'Recovered' }])
    expect(calls).toBe(4)
  })

  it('doubles the per-engine backoff on consecutive trips', async () => {
    const blocked = stubEngine('mojeek', { error: new Error('HTTP 403') })
    const subject = provider([blocked.engine], { failureCooldownMs: 0, engineBackoffMs: 50, maxEngineBackoffMs: 200 })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(blocked.calls).toHaveLength(1) // trip 1: open 50ms
    await new Promise(resolve => setTimeout(resolve, 80))
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(blocked.calls).toHaveLength(2) // probed, re-tripped: now open for 100ms
    await new Promise(resolve => setTimeout(resolve, 80))
    // Still inside the doubled 100ms window: skipped, no request goes out.
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /skipped \(recent failures: HTTP 403\)/,
    })
    expect(blocked.calls).toHaveLength(2)
  })

  it('engineBackoffMs: 0 disables the per-engine breaker', async () => {
    const blocked = stubEngine('ecosia', { error: new Error('HTTP 403') })
    const healthy = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/12', title: 'OK' }] })
    const subject = provider([blocked.engine, healthy.engine], { engineBackoffMs: 0 })
    await subject.search({ query: 'q' })
    await subject.search({ query: 'q' })
    // Breaker disabled: the 403 engine is still queried on every search.
    expect(blocked.calls).toHaveLength(2)
  })

  it('counts engines still in flight at the hard deadline as failed', async () => {
    const first: PublicEngine = {
      id: 'startpage',
      async search(): Promise<WebSearchSource[]> {
        return new Promise(() => {}) // never settles, ignores abort
      },
    }
    const second: PublicEngine = {
      id: 'duckduckgo',
      async search(): Promise<WebSearchSource[]> {
        return new Promise(() => {})
      },
    }
    await expect(provider([first, second], { softDeadlineMs: 10, hardDeadlineMs: 40 }).search({ query: 'q' }))
      .rejects.toMatchObject({
        code: 'WEB_PROVIDER_ERROR',
        message:
          'all public search engines failed: startpage: did not settle before the hard deadline; duckduckgo: did not settle before the hard deadline',
      })
  })

  it('spends the aggregate deadline across retries instead of restarting it', async () => {
    const slow = stubEngine('mojeek', { error: new Error('HTTP 502'), delayMs: 25 })
    const subject = provider([slow.engine], { maxRetries: 1, retryDelayMs: 5, softDeadlineMs: 5, hardDeadlineMs: 15 })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /did not settle before the hard deadline/,
    })
    // The retry guard saw the deadline spent: no second attempt went out.
    expect(slow.calls).toHaveLength(1)
  })

  it('returns [] when one engine fails and another accepts the search with zero results', async () => {
    const blocked = stubEngine('startpage', { error: new Error('HTTP 403') })
    const empty = stubEngine('duckduckgo', { sources: [] })
    const result = await provider([blocked.engine, empty.engine]).search({ query: 'q' })
    // The accepted empty page is a legitimate answer, not an aggregate failure.
    expect(result).toEqual({ sources: [], truncated: false })
  })

  it('counts one vote per canonical URL within a single engine answer', async () => {
    const variants = stubEngine('startpage', { sources: [
      { url: 'https://example.com/shared', title: 'Shared', snippet: 'best-ranked snippet' },
      { url: 'https://www.example.com/shared/', title: 'Shared (www variant)', snippet: 'later variant snippet' },
    ] })
    const other = stubEngine('duckduckgo', { sources: [{ url: 'https://example.com/shared', title: 'Shared (ddg)' }] })
    const result = await provider([variants.engine, other.engine]).search({ query: 'q' })
    // URL variants inside ONE engine answer collapse to a single consensus
    // vote (the best-ranked variant wins); the cross-engine vote still merges.
    expect(result.sources).toEqual([
      { url: 'https://example.com/shared', title: 'Shared', snippet: 'best-ranked snippet' },
    ])
  })

  it('retries a structured HTTP 5xx failure but not a structured 4xx', async () => {
    let calls = 0
    const flaky: PublicEngine = {
      id: 'mojeek',
      async search(): Promise<WebSearchSource[]> {
        calls += 1
        if (calls === 1) throw new EngineSearchFailure('http', 'HTTP 503', 503)
        return [{ url: 'https://m.test/15', title: 'Recovered' }]
      },
    }
    const result = await provider([flaky], { maxRetries: 1, retryDelayMs: 5 }).search({ query: 'q' })
    expect(calls).toBe(2)
    expect(result.sources).toEqual([{ url: 'https://m.test/15', title: 'Recovered' }])
  })

  it('trips the breaker on a structured HTTP 4xx without retrying', async () => {
    const blocked = stubEngine('mojeek', { error: new EngineSearchFailure('http', 'HTTP 403', 403) })
    const subject = provider([blocked.engine], {
      maxRetries: 3,
      retryDelayMs: 2,
      failureCooldownMs: 0,
      engineBackoffMs: 5_000,
    })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'all public search engines failed: mojeek: HTTP 403',
    })
    expect(blocked.calls).toHaveLength(1)
    // The breaker is open on the next search: the engine is skipped outright.
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /skipped \(recent failures: HTTP 403\)/,
    })
    expect(blocked.calls).toHaveLength(1)
  })

  it('preserves breaker state from the last substantive attempt when the retry sleeps into the deadline', async () => {
    // Attempt 1 fails fast with a soft (retryable) 503; the retry backoff
    // outlives the remaining deadline, so attempt 2 short-circuits. The
    // final error must still carry attempt 1's evidence: the engine breaker
    // opens and the cooldown arms instead of the next search re-blasting.
    const failing = stubEngine('startpage', { error: new EngineSearchFailure('http', 'HTTP 503', 503) })
    const subject = provider([failing.engine], {
      softDeadlineMs: 10,
      hardDeadlineMs: 40,
      maxRetries: 3,
      retryDelayMs: 50,
      engineBackoffMs: 5_000,
      failureCooldownMs: 0,
    })
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /all public search engines failed: startpage: HTTP 503/,
    })
    expect(failing.calls).toHaveLength(1)
    // Next search: the breaker opened from the substantive attempt, so the
    // engine is skipped instead of contacted again.
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: /skipped \(recent failures: transport failure\)/,
    })
    expect(failing.calls).toHaveLength(1)
  })

  it('aborts in-flight searches, drains them, and refuses new work once disposed', async () => {
    let observedAbort = false
    let slowCalls = 0
    const slow: PublicEngine = {
      id: 'startpage',
      async search(_request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
        slowCalls += 1
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000)
          signal?.addEventListener('abort', () => { observedAbort = true; clearTimeout(timer); resolve() }, { once: true })
        })
        return [{ url: 'https://s.test/16', title: 'Late' }]
      },
    }
    const healthy = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/17', title: 'Quick' }] })
    const subject = provider([slow, healthy.engine])
    const pending = subject.search({ query: 'q' })
    await vi.waitFor(() => { expect(slowCalls).toBe(1) })
    const draining = subject.dispose()
    // The in-flight search is aborted and settles as WEB_ABORTED…
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    // …and dispose() only resolves once the drained searches settled.
    await draining
    expect(observedAbort).toBe(true)
    await expect(subject.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UNAVAILABLE',
      message: /disposed/,
    })
  })

  it('drains engine work orphaned by an early soft-deadline return when disposing', async () => {
    let settledSlow = false
    let releaseSlow: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const slow: PublicEngine = {
      id: 'startpage',
      async search(_request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]> {
        // Register before the gate: the search signal may already be aborted
        // (disposed) by the time the gate releases, and an aborted signal
        // never retroactively dispatches to later listeners.
        signal?.addEventListener('abort', () => { settledSlow = true }, { once: true })
        await gate
        return []
      },
    }
    const fast = stubEngine('duckduckgo', { sources: [{ url: 'https://d.test/18', title: 'Quick' }] })
    const subject = provider([slow, fast.engine], { softDeadlineMs: 10, hardDeadlineMs: 5_000 })

    // The fast engine wins the soft-deadline race; the slow engine's attempt
    // stays pending inside the fan-out aggregate after search() has returned.
    const result = await subject.search({ query: 'q' })
    expect(result.sources).toHaveLength(1)

    // dispose() must not resolve until the orphaned engine work settles.
    let disposeResolved = false
    const drained = subject.dispose().then(() => { disposeResolved = true })
    // Even though dispose() aborted the lifetime signal, the gated engine has
    // not settled — the drain must still be pending.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(disposeResolved).toBe(false)
    releaseSlow?.()
    await vi.waitFor(() => { expect(disposeResolved).toBe(true) })
    await drained
    expect(settledSlow).toBe(true)
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
        // Pages without challenge markers parse to zero organic results —
        // accepted as legitimate empties by the fan-out.
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
