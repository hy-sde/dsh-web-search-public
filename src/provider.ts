/**
 * `PublicSearchProvider`: a `WebSearchProvider` that fans one query out to all
 * the credential-free public engines concurrently — Startpage → DuckDuckGo →
 * Ecosia → Google → Mojeek — and consolidates their answers. No API key or
 * credential is required. The fan-out races three exits and returns at the
 * earliest: every engine settled; the soft deadline elapsed with at least one
 * success in hand; the hard deadline elapsed regardless. Sources are
 * deduplicated across engines and ranked by cross-engine consensus (how many
 * engines returned a URL), then by best per-engine rank. Individual engine
 * failures (bot challenges, timeouts) are tolerated; the call fails only when
 * every engine fails. This is a faithful port of oh-my-pi's `searchPublicWeb`.
 * @module @hy-sde-org/dsh-web-search-public/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { PublicEngine } from './types.ts'

/** Stable id this provider registers under in `ctx.web`. */
export const PUBLIC_PROVIDER_ID = 'public'

/**
 * Soft aggregate deadline (ms): past this point the fan-out returns as soon as
 * it has at least one engine's sources. Fast HTML engines answer well under
 * this; the deadline is the latency floor for stragglers the aggregate waits
 * on to enrich consensus.
 */
export const SOFT_DEADLINE_MS = 5_000

/**
 * Hard aggregate deadline (ms): the fan-out returns whatever it has, even
 * nothing, so one pathologically slow engine can never pin the call to the
 * search-tool budget.
 */
export const HARD_DEADLINE_MS = 30_000

/** Resolved provider options (the plugin's `apply` supplies config defaults). */
export interface PublicSearchProviderOptions {
  /**
   * Engines the fan-out races concurrently. Order is the tiebreak for merged
   * ranking (earlier engines win equal consensus/rank).
   */
  readonly engines: readonly PublicEngine[]
  /** Per-engine transport timeout (ms); an engine stalls if it ignores abort. */
  readonly timeoutMs: number
  /** Soft aggregate deadline (ms). Default: {@link SOFT_DEADLINE_MS}. */
  readonly softDeadlineMs?: number
  /** Hard aggregate deadline (ms). Default: {@link HARD_DEADLINE_MS}. */
  readonly hardDeadlineMs?: number
}

type EngineAttempt =
  | { readonly kind: 'ok'; readonly sources: WebSearchSource[] }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'failed'; readonly message: string }

/** Accumulator for one deduplicated URL across engines. */
export interface MergedSource {
  source: WebSearchSource
  /** Number of engines that returned this URL — the primary ranking signal. */
  engines: number
  /** Best (lowest) per-engine rank observed. */
  bestRank: number
  /** First-seen insertion index; final tiebreak keeps ordering deterministic. */
  order: number
}

/**
 * Canonical dedup key for a result URL: case-normalized host without a leading
 * `www.`, path without a trailing slash, query preserved, fragment dropped.
 * Engines disagree on exactly these variations for the same page.
 */
export function dedupKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')
    let path = url.pathname
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
    return `${host}${path}${url.search}`
  } catch {
    return rawUrl
  }
}

/** Merge one engine's ranked sources into the accumulator map. Exported for tests. */
export function mergeSources(merged: Map<string, MergedSource>, sources: readonly WebSearchSource[]): void {
  for (const [rank, source] of sources.entries()) {
    const key = dedupKey(source.url)
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size })
      continue
    }
    existing.engines += 1
    if (rank < existing.bestRank) {
      existing.bestRank = rank
      existing.source = {
        ...existing.source,
        ...(source.title !== undefined ? { title: source.title } : {}),
        url: source.url,
      }
    }
    // Keep the most informative snippet regardless of which engine ranked it best.
    if (source.snippet !== undefined && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
      existing.source = { ...existing.source, snippet: source.snippet }
    }
    if (existing.source.publishedAt === undefined && source.publishedAt !== undefined) {
      existing.source = { ...existing.source, publishedAt: source.publishedAt }
    }
  }
}

/** Resolve a `WebSearchResult` from merged consensus sources, capped to `maxResults`. */
function toResult(merged: Map<string, MergedSource>, maxResults: number | undefined): WebSearchResult {
  const all = [...merged.values()]
    .sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
    .map(entry => entry.source)
  return {
    sources: maxResults === undefined ? all : all.slice(0, maxResults),
    truncated: false,
  }
}

/** The credential-free public web search provider. */
export class PublicSearchProvider implements WebSearchProvider {
  readonly id = PUBLIC_PROVIDER_ID

  constructor(private readonly options: PublicSearchProviderOptions) {}

  /** Credential-free: usable whenever at least one engine is configured. */
  available(): boolean {
    return this.options.engines.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw aborted()
    const engines = this.options.engines
    if (engines.length === 0) {
      throw new WebError('no public search engines configured', 'WEB_PROVIDER_UNAVAILABLE')
    }
    const softMs = this.options.softDeadlineMs ?? SOFT_DEADLINE_MS
    const hardMs = this.options.hardDeadlineMs ?? HARD_DEADLINE_MS

    // Fan out to every engine concurrently. Each engine composes its own
    // per-engine timeout on top of the shared race signal; the straggler
    // controller lets the aggregate cancel still-running engines once it
    // decides to return. Individual failures are tolerated — the call fails
    // only when every engine fails.
    const straggler = new AbortController()
    const raceSignal = signal ? AbortSignal.any([signal, straggler.signal]) : straggler.signal

    const responses = new Array<readonly WebSearchSource[] | undefined>(engines.length)
    const failures: string[] = []
    let resolveFirstSuccess: () => void = () => {}
    const firstSuccess = new Promise<void>((resolve) => { resolveFirstSuccess = resolve })

    const all = Promise.all(engines.map(async (engine, index) => {
      const attempt = await this.attempt(engine, request, raceSignal)
      if (attempt.kind === 'ok' && attempt.sources.length > 0) {
        responses[index] = attempt.sources
        resolveFirstSuccess()
      } else if (attempt.kind === 'ok') {
        failures.push(`${engine.id}: no results`)
      } else if (attempt.kind === 'timedOut') {
        failures.push(`${engine.id}: timed out after ${this.options.timeoutMs}ms`)
      } else if (attempt.message !== 'aborted by caller') {
        failures.push(`${engine.id}: ${attempt.message}`)
      }
    }))

    // Earliest exit wins: every engine settled, soft deadline with a success in
    // hand, or (with no success yet and not everything failed) the first
    // success, bounded by the hard deadline.
    await Promise.race([all, sleep(softMs)])
    const hasSuccess = responses.some(response => response !== undefined)
    if (!hasSuccess && failures.length < engines.length) {
      await Promise.race([all, firstSuccess, sleep(Math.max(0, hardMs - softMs))])
    }
    straggler.abort()
    if (signal?.aborted) throw aborted()

    const merged = new Map<string, MergedSource>()
    for (const response of responses) {
      if (response !== undefined) mergeSources(merged, response)
    }
    if (merged.size === 0 && failures.length === engines.length) {
      throw new WebError(`all public search engines failed: ${failures.join('; ')}`, 'WEB_PROVIDER_ERROR')
    }
    return toResult(merged, request.maxResults)
  }

  private async attempt(
    engine: PublicEngine,
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
  ): Promise<EngineAttempt> {
    const controller = new AbortController()
    const deadline = AbortSignal.timeout(this.options.timeoutMs)
    const abortEngine = (): void => { controller.abort() }
    const onDeadline = (): void => {
      // Force a signal-ignoring engine to stop as soon as the deadline fires.
      abortEngine()
    }
    deadline.addEventListener('abort', onDeadline, { once: true })
    if (signal?.aborted) {
      deadline.removeEventListener('abort', onDeadline)
      return { kind: 'failed', message: 'aborted by caller' }
    }
    signal?.addEventListener('abort', abortEngine, { once: true })

    try {
      const outcome = await Promise.race([
        engine.search(request, controller.signal).then(
          sources => ({ kind: 'ok' as const, sources }),
          (error: unknown) => ({ kind: 'failed' as const, message: error instanceof Error ? error.message : String(error) }),
        ),
        new Promise<{ readonly kind: 'timedOut' }>((resolve) => {
          deadline.addEventListener('abort', () => { resolve({ kind: 'timedOut' }) }, { once: true })
        }),
      ])
      return signal?.aborted ? { kind: 'failed' as const, message: 'aborted by caller' } : outcome
    } finally {
      controller.abort()
      deadline.removeEventListener('abort', onDeadline)
      signal?.removeEventListener('abort', abortEngine)
    }
  }
}

/** Resolve after `ms` ms; used to bound the fan-out race. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function aborted(): WebError {
  return new WebError('public web search aborted', 'WEB_ABORTED')
}
