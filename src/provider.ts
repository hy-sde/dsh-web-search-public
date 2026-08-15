/**
 * `PublicSearchProvider`: a `WebSearchProvider` that chains the credential-free
 * public engines sequentially — Startpage first, then DuckDuckGo → Ecosia →
 * Google → Mojeek — and returns the first engine that yields sources. No API
 * key or credential is required. Each engine runs under its own per-engine
 * timeout (a real race, so a hung engine cannot pin the call); on timeout or
 * any failure the chain advances to the next engine, so a single
 * bot-challenged result page degrades to the next engine rather than failing
 * the call. Only when every engine fails does the call surface
 * `WEB_PROVIDER_ERROR`.
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

/** Resolved provider options (the plugin's `apply` supplies config defaults). */
export interface PublicSearchProviderOptions {
  /** Engines tried in order; the first engine that yields sources wins. */
  readonly engines: readonly PublicEngine[]
  /** Per-engine transport timeout (ms). */
  readonly timeoutMs: number
}

type EngineAttempt =
  | { readonly kind: 'ok'; readonly sources: WebSearchSource[] }
  | { readonly kind: 'timedOut' }
  | { readonly kind: 'failed'; readonly message: string }

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
    const failures: string[] = []
    for (const engine of this.options.engines) {
      if (signal?.aborted) throw aborted()
      const attempt = await this.attempt(engine, request, signal)
      if (attempt.kind === 'ok') {
        if (attempt.sources.length > 0) return { sources: attempt.sources, truncated: false }
        failures.push(`${engine.id}: no results`)
      } else if (attempt.kind === 'timedOut') {
        failures.push(`${engine.id}: timed out after ${this.options.timeoutMs}ms`)
      } else if (attempt.message !== 'aborted by caller') {
        failures.push(`${engine.id}: ${attempt.message}`)
      }
    }
    if (signal?.aborted) throw aborted()
    if (failures.length > 0) {
      throw new WebError(`all public search engines failed: ${failures.join('; ')}`, 'WEB_PROVIDER_ERROR')
    }
    throw new WebError('no public search engines configured', 'WEB_PROVIDER_UNAVAILABLE')
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

function aborted(): WebError {
  return new WebError('public web search aborted', 'WEB_ABORTED')
}
