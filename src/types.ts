/**
 * Vocabulary for `@hy-sde-org/dsh-web-search-public`: the credential-free engine ids and
 * interfaces the provider fans out to.
 * @module @hy-sde-org/dsh-web-search-public/types
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'

/** The anonymous engines the provider fans out to. */
export const PUBLIC_ENGINE_IDS = [
  'startpage',
  'duckduckgo',
  'ecosia',
  'google',
  'mojeek',
] as const

export type PublicEngineId = (typeof PUBLIC_ENGINE_IDS)[number]

/** Default engine order — the tiebreak for consensus ties, not a fallback sequence. */
export const DEFAULT_ENGINE_ORDER: readonly PublicEngineId[] = PUBLIC_ENGINE_IDS

/**
 * Default per-engine transport timeout (ms). The fan-out starts every engine
 * concurrently and bounds the whole call with soft/hard aggregate deadlines
 * (5 s / 30 s), so this cap only limits one engine that ignores the
 * aggregate's cancellation. Browser-backed engines (google/ecosia/mojeek) may
 * spend it on fetch → stealth-browser escalation, so the default is 30 s —
 * comfortably under the 60 s search-tool budget mounted by the web seam.
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 30_000

/** One credential-free search backend the provider fans out to. */
export interface PublicEngine {
  readonly id: PublicEngineId
  /**
   * Execute one search.
   * @throws {@link EngineSearchFailure} with a structured `kind` when the
   * failure is classifiable (challenge wall, HTTP status, transport problem,
   * cancellation); plain `Error`s from third-party engines fall back to the
   * provider's legacy message signatures.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]>
}

/**
 * Structured failure kinds an engine transport can surface. They replace
 * message-regex classification: `challenge` marks an anti-bot wall (trips the
 * engine's circuit breaker immediately), `http` carries the status (4xx is a
 * hard block, 5xx is retryable), `transport` is a network-level failure
 * (retryable), and `canceled` is a caller or aggregate abort (ignored by the
 * aggregate — not an engine failure).
 */
export type EngineFailureKind = 'challenge' | 'http' | 'transport' | 'canceled'

/**
 * Error an engine raises when the failure kind is known structurally. The
 * provider maps it onto the matching attempt outcome without message
 * sniffing; unknown errors keep the legacy signature fallback.
 */
export class EngineSearchFailure extends Error {
  readonly kind: EngineFailureKind
  /** HTTP status when `kind === 'http'`. */
  readonly status?: number

  constructor(kind: EngineFailureKind, message: string, status?: number) {
    super(message)
    this.name = 'EngineSearchFailure'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

/**
 * User-Agent sent to the anonymous engines. A browser-shaped agent is used
 * because these endpoints treat browser-like clients as legitimate traffic;
 * this is the public-web scrape distinct from `@deepseek-ai/dsh-web-fetch-http`,
 * which deliberately identifies itself.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
