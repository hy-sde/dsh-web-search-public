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
 * concurrently and bounds the whole call with soft/hard aggregate deadlines,
 * so this cap only limits one engine that ignores the aggregate's cancellation
 * — comfortably under the 60 s search-tool budget `dsh-tool-web` mounts in the
 * base bundle.
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 10_000

/** One credential-free search backend the provider fans out to. */
export interface PublicEngine {
  readonly id: PublicEngineId
  /**
   * Execute one search.
   * @throws Error with a human-readable message on transport or parse failure.
   */
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchSource[]>
}

/**
 * User-Agent sent to the anonymous engines. A browser-shaped agent is used
 * because these endpoints treat browser-like clients as legitimate traffic;
 * this is the public-web scrape distinct from `@deepseek-ai/dsh-web-fetch-http`,
 * which deliberately identifies itself.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
