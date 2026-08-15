/**
 * Vocabulary for `@hy-sde-org/dsh-web-search-public`: the credential-free engine ids and
 * interfaces the provider chains over.
 * @module @hy-sde-org/dsh-web-search-public/types
 */

import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'

/** The anonymous engines the provider can chain over. */
export const PUBLIC_ENGINE_IDS = [
  'startpage',
  'duckduckgo',
  'ecosia',
  'google',
  'mojeek',
] as const

export type PublicEngineId = (typeof PUBLIC_ENGINE_IDS)[number]

/** Default engine fallback order — Startpage first, then DuckDuckGo → Ecosia → Google → Mojeek. */
export const DEFAULT_ENGINE_ORDER: readonly PublicEngineId[] = PUBLIC_ENGINE_IDS

/**
 * Default per-engine transport timeout (ms). The chain's worst case is
 * engines.length × timeoutMs; with the default five engines that is 50 s,
 * under the 60 s search-tool budget `dsh-tool-web` mounts in the base bundle.
 */
export const DEFAULT_ENGINE_TIMEOUT_MS = 10_000

/** One credential-free search backend the provider chains over. */
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
