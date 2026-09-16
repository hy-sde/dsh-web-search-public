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
import type { PublicEngine, PublicEngineId } from './types.ts'

/**
 * Error channel for one engine's failed search. Tagged so the effect error
 * stays typed; it is recovered into the `failed` attempt kind immediately
 * inside the attempt effect and never escapes.
 */
class EngineSearchError extends Data.TaggedError('EngineSearchError')<{ readonly cause: unknown }> { }

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
 * from a *retryable* transport failure (HTTP 5xx, a timeout, or a network-level
 * fetch failure). A retry re-runs the whole fan-out after a backoff, so a short
 * engine throttle that strips the first attempt still yields results. Hard
 * blocks (HTTP 4xx — the anti-bot rate-limit signature) are never retried:
 * they open that engine's circuit breaker instead. 0 disables retrying.
 */
export const DEFAULT_MAX_RETRIES = 1

/** Base delay before retry #1 (ms); doubles on each subsequent attempt. */
export const DEFAULT_RETRY_DELAY_MS = 2_000

/**
 * Fast-fail window (ms) after an all-engines-down failure (retry exhausted, or
 * every engine hard-blocked/tripped): searches in this window return a clear
 * "retry in about Ns" error instead of re-blasting engines that just throttled
 * us, which would deepen the block. 0 disables the window. Default: 5 minutes.
 */
export const DEFAULT_FAILURE_COOLDOWN_MS = 300_000

/**
 * Base per-engine circuit-breaker window (ms): an engine that hard-blocks
 * (HTTP 4xx) or trips the empty-result streak is skipped for this long instead
 * of being re-blasted on every search. The window doubles per consecutive trip
 * up to {@link DEFAULT_MAX_ENGINE_BACKOFF_MS} and resets after a successful
 * probe. 0 disables the per-engine breaker. Default: 5 minutes.
 */
export const DEFAULT_ENGINE_BACKOFF_MS = 300_000

/** Cap for the doubled per-engine circuit-breaker window. Default: 1 hour. */
export const DEFAULT_MAX_ENGINE_BACKOFF_MS = 3_600_000

/**
 * Consecutive zero-result responses that open an engine's soft circuit
 * breaker. A single obscure query must not disable an engine; a block page
 * that parses to zero results repeats for *every* query, so two in a row is
 * the block signal.
 */
const EMPTY_STREAK_TO_TRIP = 2

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
   * Retries for the all-failed aggregate on the retryable transport signature.
   * Default: {@link DEFAULT_MAX_RETRIES}. 0 disables.
   */
  readonly maxRetries?: number
  /** Base retry delay (ms), doubled per attempt. Default: {@link DEFAULT_RETRY_DELAY_MS}. */
  readonly retryDelayMs?: number
  /**
   * Fast-fail window (ms) after an all-engines-down failure.
   * Default: {@link DEFAULT_FAILURE_COOLDOWN_MS}. 0 disables.
   */
  readonly failureCooldownMs?: number
  /**
   * Base per-engine circuit-breaker window (ms); doubles per consecutive trip
   * up to `maxEngineBackoffMs`. Default: {@link DEFAULT_ENGINE_BACKOFF_MS}.
   * 0 disables the per-engine breaker.
   */
  readonly engineBackoffMs?: number
  /**
   * Cap for the doubled per-engine circuit-breaker window.
   * Default: {@link DEFAULT_MAX_ENGINE_BACKOFF_MS}.
   */
  readonly maxEngineBackoffMs?: number
}

type EngineAttempt =
  | { readonly kind: 'ok'; readonly sources: WebSearchSource[] }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'failed'; readonly message: string }

/** Per-engine circuit-breaker state. */
interface EngineHealth {
  /** Epoch ms until which the engine is skipped; 0 = healthy. */
  brokenUntil: number
  /** Current backoff window (doubles per consecutive trip, resets on recovery). */
  backoffMs: number
  /** Consecutive zero-result searches (soft trip signal). */
  emptyStreak: number
  /** Why the breaker opened last, surfaced in the aggregate error. */
  reason: string
}

/**
 * Internal aggregate-failure signal. Carries the per-engine detail the
 * provider needs to decide retry vs. trip vs. cooldown; converted to a
 * `WEB_PROVIDER_ERROR` {@link WebError} only at the `search` boundary.
 */
class AllFailedError extends Error {
  readonly failures: readonly string[]
  readonly skipped: readonly string[]
  readonly hardFailed: readonly PublicEngineId[]
  readonly softFailed: readonly PublicEngineId[]
  /** Number of per-engine breaker trips recorded during this fan-out. */
  readonly trips: number

  constructor(
    failures: readonly string[],
    skipped: readonly string[],
    hardFailed: readonly PublicEngineId[],
    softFailed: readonly PublicEngineId[],
    trips: number,
  ) {
    const detail = failures.length > 0
      ? `all public search engines failed: ${[...failures, ...skipped].join('; ')}`
      : `all public search engines unavailable: ${skipped.join('; ')}`
    super(detail)
    this.name = 'AllFailedError'
    this.failures = failures
    this.skipped = skipped
    this.hardFailed = hardFailed
    this.softFailed = softFailed
    this.trips = trips
  }
}

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

/**
 * Hard block signature: HTTP 4xx (403, 429, …) — the anti-bot rate-limit
 * answer. Never retried; opens the engine's circuit breaker immediately.
 */
const HARD_BLOCK_RE = /HTTP 4\d\d/

/**
 * Retryable transport signature: HTTP 5xx, a timeout, or a network-level fetch
 * failure. Retried once per budget; if it persists past the retry budget the
 * engine's circuit breaker opens.
 */
const SOFT_TRANSPORT_RE = /HTTP 5\d\d|timed out|fetch failed/i

/** Whether one engine died on a hard anti-bot block. */
function isHardBlock(message: string): boolean {
  return HARD_BLOCK_RE.test(message)
}

/** Whether one engine died on a retryable transport problem. */
function isSoftTransport(message: string): boolean {
  return SOFT_TRANSPORT_RE.test(message)
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
  /** Resolved per-engine breaker base window (see {@link PublicSearchProviderOptions.engineBackoffMs}). */
  private readonly engineBackoffMs: number
  /** Resolved per-engine breaker cap (see {@link PublicSearchProviderOptions.maxEngineBackoffMs}). */
  private readonly maxEngineBackoffMs: number
  /** Epoch ms of the last all-engines-down failure; 0 = none yet. */
  private lastAllFailureAt = 0
  /** Aggregate message of that last failure, surfaced by fast-fails. */
  private lastAllFailureMessage = ''
  /** Per-engine circuit-breaker state, keyed by engine id. */
  private readonly health = new Map<PublicEngineId, EngineHealth>()

  constructor(private readonly options: PublicSearchProviderOptions) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS
    this.engineBackoffMs = options.engineBackoffMs ?? DEFAULT_ENGINE_BACKOFF_MS
    this.maxEngineBackoffMs = options.maxEngineBackoffMs ?? DEFAULT_MAX_ENGINE_BACKOFF_MS
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
    // Fast-fail during the cooldown window after an all-engines-down failure:
    // re-blasting engines that just throttled us deepens the block, so surface
    // a clear "try again shortly" error instead of burning requests.
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
    // Retry the whole fan-out when every engine failed and at least one died on
    // a retryable transport problem (HTTP 5xx / timeout / network failure).
    // Hard blocks (HTTP 4xx) and pure all-no-results aggregates are
    // query-level/hostile and fail immediately. Engines that open their
    // circuit breaker mid-search are skipped by the retry pass.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.fanOut(request, signal)
      } catch (error) {
        if (error instanceof AllFailedError) {
          if (error.softFailed.length > 0 && attempt < this.maxRetries) {
            await sleep(this.retryDelayMs * 2 ** attempt, signal)
            continue
          }
          // Retry budget exhausted (or no retryable cause): soft-failed engines
          // open their breaker too, so the next search probes fewer engines.
          for (const id of error.softFailed) this.trip(id, 'transport failure')
          if (error.skipped.length > 0 || error.trips > 0 || error.softFailed.length > 0) {
            this.lastAllFailureAt = Date.now()
            this.lastAllFailureMessage = error.message
          }
          throw new WebError(error.message, 'WEB_PROVIDER_ERROR')
        }
        throw error
      }
    }
  }

  /**
   * One fan-out pass over every engine (the pre-retry aggregate): races the
   * soft/hard deadlines, merges the consensus result, and throws
   * {@link AllFailedError} only when every engine failed or was skipped.
   */
  private async fanOut(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const engines = this.options.engines
    const softMs = this.options.softDeadlineMs ?? SOFT_DEADLINE_MS
    const hardMs = this.options.hardDeadlineMs ?? HARD_DEADLINE_MS

    // Fan out to every engine concurrently. Each engine composes its own
    // per-engine timeout on top of the shared race signal; the straggler
    // controller lets the aggregate cancel still-running engines once it
    // decides to return. Individual failures are tolerated — the call fails
    // only when every engine fails. Engines whose circuit breaker is open are
    // skipped without a network request.
    const straggler = new AbortController()
    const raceSignal = signal ? AbortSignal.any([signal, straggler.signal]) : straggler.signal

    const responses = new Array<readonly WebSearchSource[] | undefined>(engines.length)
    const failures: string[] = []
    const skipped: string[] = []
    const hardFailed: PublicEngineId[] = []
    const softFailed: PublicEngineId[] = []
    const tripCounter = { count: 0 }
    let resolveFirstSuccess: () => void = () => { }
    const firstSuccess = new Promise<void>((resolve) => { resolveFirstSuccess = resolve })

    const all = Promise.all(engines.map(async (engine, index) => {
      const tripped = this.isTripped(engine.id)
      if (tripped.tripped) {
        skipped.push(`${engine.id}: skipped (recent failures: ${tripped.reason})`)
        return
      }
      const attempt = await this.attempt(engine, request, raceSignal)
      if (attempt.kind === 'ok' && attempt.sources.length > 0) {
        responses[index] = attempt.sources
        this.recordSuccess(engine.id)
        resolveFirstSuccess()
      } else if (attempt.kind === 'ok') {
        failures.push(`${engine.id}: no results`)
        this.recordEmpty(engine.id, tripCounter)
      } else if (attempt.kind === 'timedOut') {
        failures.push(`${engine.id}: timed out after ${this.options.timeoutMs}ms`)
        softFailed.push(engine.id)
      } else if (attempt.message !== 'aborted by caller') {
        failures.push(`${engine.id}: ${attempt.message}`)
        if (isHardBlock(attempt.message)) {
          hardFailed.push(engine.id)
          this.recordTrip(engine.id, attempt.message, tripCounter)
        } else if (isSoftTransport(attempt.message)) {
          softFailed.push(engine.id)
        }
      }
    }))

    // Earliest exit wins: every engine settled, soft deadline with a success in
    // hand, or (with no success yet and not everything failed) the first
    // success, bounded by the hard deadline.
    await Promise.race([all, sleep(softMs)])
    const hasSuccess = responses.some(response => response !== undefined)
    if (!hasSuccess && failures.length + skipped.length < engines.length) {
      await Promise.race([all, firstSuccess, sleep(Math.max(0, hardMs - softMs))])
    }
    straggler.abort()
    if (signal?.aborted) throw aborted()

    const merged = new Map<string, MergedSource>()
    for (const response of responses) {
      if (response !== undefined) mergeSources(merged, response)
    }
    if (merged.size === 0 && failures.length + skipped.length === engines.length) {
      throw new AllFailedError(failures, skipped, hardFailed, softFailed, tripCounter.count)
    }
    return toResult(merged, request.maxResults)
  }

  /** Whether an engine's circuit breaker is open right now. */
  private isTripped(id: PublicEngineId): { tripped: boolean; reason: string } {
    if (this.engineBackoffMs <= 0) return { tripped: false, reason: '' }
    const h = this.healthOf(id)
    if (h.brokenUntil > Date.now()) return { tripped: true, reason: h.reason }
    return { tripped: false, reason: '' }
  }

  /** Open an engine's breaker and count the trip for the aggregate classifier. */
  private recordTrip(id: PublicEngineId, reason: string, counter: { count: number }): void {
    if (this.trip(id, reason)) counter.count += 1
  }

  /** Open an engine's circuit breaker; returns whether the breaker is armed. */
  private trip(id: PublicEngineId, reason: string): boolean {
    if (this.engineBackoffMs <= 0) return false
    const h = this.healthOf(id)
    const window = h.backoffMs === 0
      ? this.engineBackoffMs
      : Math.min(h.backoffMs * 2, this.maxEngineBackoffMs)
    h.backoffMs = window
    h.brokenUntil = Date.now() + window
    h.reason = reason
    h.emptyStreak = 0
    return true
  }

  /** Clear the empty streak; a successful probe also resets the backoff window. */
  private recordSuccess(id: PublicEngineId): void {
    const h = this.healthOf(id)
    h.emptyStreak = 0
    if (h.brokenUntil > 0) {
      h.brokenUntil = 0
      h.backoffMs = 0
    }
  }

  /**
   * Count a zero-result response. Repeated empties are the soft block signal
   * (challenge pages parse to zero results for every query, while a genuinely
   * obscure query answers empty once): the streak opens the breaker.
   */
  private recordEmpty(id: PublicEngineId, counter: { count: number }): void {
    const h = this.healthOf(id)
    h.emptyStreak += 1
    if (h.emptyStreak >= EMPTY_STREAK_TO_TRIP) {
      this.recordTrip(id, `no results on ${h.emptyStreak} consecutive searches`, counter)
    }
  }

  private healthOf(id: PublicEngineId): EngineHealth {
    let h = this.health.get(id)
    if (h === undefined) {
      h = { brokenUntil: 0, backoffMs: 0, emptyStreak: 0, reason: '' }
      this.health.set(id, h)
    }
    return h
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
    const program = Effect.gen(function*() {
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

function aborted(): WebError {
  return new WebError('public web search aborted', 'WEB_ABORTED')
}
