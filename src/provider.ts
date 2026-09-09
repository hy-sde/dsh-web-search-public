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
import { Cause, Data, Effect, Scheduler } from 'effect'
import type { PublicEngine } from './types.ts'

/**
 * Error channel for one engine's failed search. Tagged so the effect error
 * stays typed; it is recovered into the `failed` attempt kind immediately
 * inside the attempt effect and never escapes.
 */
class EngineSearchError extends Data.TaggedError('EngineSearchError')<{ readonly cause: unknown }> {}

/**
 * Effect's default scheduler dispatches on `setImmediate`; the sync scheduler
 * dispatches on `queueMicrotask`, which vitest's fake timers do not mock. The
 * family's tests use fake timers heavily, so every plugin-side Effect runtime
 * must pin the sync scheduler or cancel-without-advancing tests deadlock.
 */
const syncScheduler = new Scheduler.MixedScheduler('sync')

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

/**
 * Retries for the all-engines-failed aggregate when at least one engine died
 * from a transport failure (HTTP 4xx/5xx or a timeout) — the anti-bot
 * rate-limit signature. A retry re-runs the whole fan-out after a backoff, so
 * a short engine throttle that strips the first attempt still yields results.
 * 0 disables retrying.
 */
export const DEFAULT_MAX_RETRIES = 1

/** Base delay before retry #1 (ms); doubles on each subsequent attempt. */
export const DEFAULT_RETRY_DELAY_MS = 2_000

/**
 * Fast-fail window (ms) after a retry-exhausted rate-limit failure: searches in
 * this window return a clear "retry in about Ns" error instead of re-blasting
 * engines that just throttled us, which would deepen the block. 0 disables the
 * window.
 */
export const DEFAULT_FAILURE_COOLDOWN_MS = 30_000

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
  /**
   * Retries for the all-failed aggregate on the rate-limit signature.
   * Default: {@link DEFAULT_MAX_RETRIES}. 0 disables.
   */
  readonly maxRetries?: number
  /** Base retry delay (ms), doubled per attempt. Default: {@link DEFAULT_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number
  /**
   * Fast-fail window (ms) after a retry-exhausted rate-limit failure.
   * Default: {@link DEFAULT_FAILURE_COOLDOWN_MS}. 0 disables.
   */
  readonly failureCooldownMs?: number
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

  /** Resolved retry count (see {@link PublicSearchProviderOptions.maxRetries}). */
  private readonly maxRetries: number
  /** Resolved base retry delay (see {@link PublicSearchProviderOptions.retryDelayMs}). */
  private readonly retryDelayMs: number
  /** Resolved fast-fail window (see {@link PublicSearchProviderOptions.failureCooldownMs}). */
  private readonly failureCooldownMs: number
  /** Epoch ms of the last retry-exhausted rate-limit failure; 0 = none yet. */
  private lastAllFailureAt = 0
  /** Aggregate message of that last rate-limit failure, surfaced by fast-fails. */
  private lastAllFailureMessage = ''

  constructor(private readonly options: PublicSearchProviderOptions) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
  }

  /** Credential-free: usable whenever at least one engine is configured. */
  available(): boolean {
    return this.options.engines.length > 0
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw aborted()
    if (this.options.engines.length === 0) {
      throw new WebError('no public search engines configured', 'WEB_PROVIDER_UNAVAILABLE')
    }
    // Fast-fail during the cooldown window after a retry-exhausted rate-limit
    // failure: re-blasting engines that just throttled us deepens the block, so
    // surface a clear "try again shortly" error instead of burning requests.
    if (this.failureCooldownMs > 0 && this.lastAllFailureAt > 0) {
      const elapsed = Date.now() - this.lastAllFailureAt
      if (elapsed < this.failureCooldownMs) {
        const seconds = Math.ceil((this.failureCooldownMs - elapsed) / 1000)
        throw new WebError(
          `public search engines are rate limited (${this.lastAllFailureMessage}); retry in about ${seconds}s`,
          'WEB_PROVIDER_ERROR',
        )
      }
    }
    // Retry the whole fan-out when every engine failed with a transport-level
    // signature (HTTP 4xx/5xx or timeout) — the anti-bot rate-limit pattern. A
    // pure all-no-results aggregate is query-level and fails immediately.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fanOut(request, signal)
      } catch (error) {
        if (
          error instanceof WebError
          && error.code === 'WEB_PROVIDER_ERROR'
          && isTransportFailure(error.message)
        ) {
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelayMs * 2 ** attempt, signal)
            continue
          }
          this.lastAllFailureAt = Date.now()
          this.lastAllFailureMessage = error.message
        }
        throw error
      }
    }
  }

  /**
   * One fan-out pass over every engine (the pre-retry aggregate): races the
   * soft/hard deadlines, merges the consensus result, and throws
   * `WEB_PROVIDER_ERROR` only when every engine failed.
   */
  private async fanOut(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const engines = this.options.engines
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

  /**
   * Run one engine with a per-engine transport deadline.
   *
   * The engine's own promise is never abandoned by management: the deadline
   * and the caller's aggregate signal both abort the engine's controller, and
   * on timeout the `Effect.timeout` interrupt still runs the Scope finalizer
   * (which signals the engine), so a signal-ignoring engine becomes a zombie
   * exactly like the old `Promise.race` — never a hang.
   *
   * `Effect.timeout` fails with `Cause.TimeoutError` on expiry; the facade
   * maps that back to the `timedOut` attempt kind the aggregate understands.
   * Deliberately not `Effect.timeoutOption`: the aggregate needs the timeout
   * distinguishable from a value-less success.
   */
  private attempt(
    engine: PublicEngine,
    request: WebSearchRequest,
    signal: AbortSignal | undefined,
  ): Promise<EngineAttempt> {
    const timeoutMs = this.options.timeoutMs
    const program = Effect.gen(function* () {
      if (signal?.aborted) return { kind: 'failed' as const, message: 'aborted by caller' }
      const controller = new AbortController()
      // Scope-owned forwarder: its release finalizer detaches the listener and
      // aborts the engine controller on every exit path — success, classified
      // failure, deadline interrupt — replacing the hand-rolled try/finally.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const abortEngine = (): void => {
            controller.abort()
          }
          signal?.addEventListener('abort', abortEngine, { once: true })
          return abortEngine
        }),
        abortEngine =>
          Effect.sync(() => {
            signal?.removeEventListener('abort', abortEngine)
            controller.abort()
          }),
      )
      // The options form's `catch` maps to the ERROR channel and receives the
      // original rejection (the bare function form wraps it in
      // Cause.UnknownError, hiding the engine's message) — carry it through as
      // a tagged error and recover it into the `failed` attempt kind here.
      const outcome = yield* Effect.tryPromise({
        try: () =>
          engine.search(request, controller.signal).then(
            sources => ({ kind: 'ok' as const, sources }),
          ),
        catch: (error: unknown) => new EngineSearchError({ cause: error }),
      }).pipe(
        Effect.match({
          onSuccess: value => value,
          onFailure: (error: EngineSearchError) => ({
            kind: 'failed' as const,
            message: error.cause instanceof Error ? error.cause.message : String(error.cause),
          }),
        }),
      )
      return signal?.aborted ? ({ kind: 'failed' as const, message: 'aborted by caller' }) : outcome
    })
    return Effect.runPromise(Effect.scoped(program.pipe(Effect.timeout(timeoutMs))), {
      scheduler: syncScheduler,
    }).catch((error: unknown) => {
      if (Cause.isTimeoutError(error)) return { kind: 'timedOut' as const }
      throw error
    })
  }
}

/** Resolve after `ms` ms, or as soon as `signal` aborts; used to bound the fan-out race and the retry backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Whether an aggregate failure message carries the rate-limit signature: at
 * least one engine died on a transport error (HTTP 4xx/5xx), a timeout, or a
 * network-level fetch failure. Returns false for query-level aggregates where
 * every engine answered "no results" — retrying those cannot help and they must
 * not arm the cooldown.
 */
function isTransportFailure(message: string): boolean {
  return /HTTP [45]\d\d|timed out|fetch failed/i.test(message)
}

function aborted(): WebError {
  return new WebError('public web search aborted', 'WEB_ABORTED')
}
