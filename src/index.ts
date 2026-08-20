/**
 * `@hy-sde-org/dsh-web-search-public`: registers a credential-free `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service): a
 * search provider does not own the `ctx.web` key — it registers INTO the seam's
 * provider registry, like the other `dsh-web-search-*` packages. The provider
 * fans one query out to all anonymous engines concurrently (Startpage →
 * DuckDuckGo → Ecosia → Google → Mojeek) and consolidates the answers by
 * cross-engine consensus, bounding the call with a soft/hard deadline pair, so
 * no API key or credential is required.
 * @module @hy-sde-org/dsh-web-search-public
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { createEngines } from './engines/index.ts'
import { HARD_DEADLINE_MS, PublicSearchProvider, SOFT_DEADLINE_MS } from './provider.ts'
import type { PublicEngineId } from './types.ts'
import {
  DEFAULT_ENGINE_ORDER,
  DEFAULT_ENGINE_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  PUBLIC_ENGINE_IDS,
} from './types.ts'

export { PUBLIC_PROVIDER_ID, dedupKey, mergeSources, PublicSearchProvider } from './provider.ts'
export type { PublicSearchProviderOptions, MergedSource } from './provider.ts'
export { HARD_DEADLINE_MS, SOFT_DEADLINE_MS } from './provider.ts'
export { createEngines } from './engines/index.ts'
export {
  DEFAULT_ENGINE_ORDER,
  DEFAULT_ENGINE_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  PUBLIC_ENGINE_IDS,
} from './types.ts'
export type { PublicEngine, PublicEngineId } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-public'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills constant defaults). */
export interface Config {
  /** Per-engine transport timeout (ms). Default: 10000. Each engine also dies here even if it ignores aggregate cancellation. */
  timeoutMs?: number
  /** Engine ids the fan-out races in this order (the tiebreak for consensus ties);
   * unlisted engines stay disabled. Default: startpage, duckduckgo, ecosia, google, mojeek. */
  engines?: PublicEngineId[]
  /** User-Agent sent to the engines. Defaults to a browser-shaped constant. */
  userAgent?: string
  /** Soft aggregate deadline (ms): return as soon as all engines settled or this passes with ≥1 success. Default: 5000. */
  softDeadlineMs?: number
  /** Hard aggregate deadline (ms): return whatever we have, even nothing. Default: 30000. */
  hardDeadlineMs?: number
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_ENGINE_TIMEOUT_MS),
  engines: z.array(z.union(PUBLIC_ENGINE_IDS)).default([...DEFAULT_ENGINE_ORDER]),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  softDeadlineMs: z.number().step(1).min(1).default(SOFT_DEADLINE_MS),
  hardDeadlineMs: z.number().step(1).min(1).default(HARD_DEADLINE_MS),
})

/** Configured timeout and deadlines must be positive integers; hard must not precede soft. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-search-public: ${name} must be a positive integer`)
  }
}

/** Register the credential-free public search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // Schemastery fills an unconfigured `engines` array with `[]`, so guards
  // cover both undefined and empty rather than relying on `??` alone.
  const engines = config.engines !== undefined && config.engines.length > 0
    ? config.engines
    : [...DEFAULT_ENGINE_ORDER]
  const userAgent = config.userAgent !== undefined && config.userAgent.length > 0
    ? config.userAgent
    : DEFAULT_USER_AGENT
  const timeoutMs = config.timeoutMs !== undefined && config.timeoutMs >= 1000
    ? config.timeoutMs
    : DEFAULT_ENGINE_TIMEOUT_MS
  const softDeadlineMs = config.softDeadlineMs !== undefined
    ? config.softDeadlineMs
    : SOFT_DEADLINE_MS
  const hardDeadlineMs = config.hardDeadlineMs !== undefined
    ? config.hardDeadlineMs
    : HARD_DEADLINE_MS
  assertPositiveInteger('timeoutMs', timeoutMs)
  assertPositiveInteger('softDeadlineMs', softDeadlineMs)
  assertPositiveInteger('hardDeadlineMs', hardDeadlineMs)
  if (hardDeadlineMs < softDeadlineMs) {
    throw new Error('web-search-public: hardDeadlineMs must be >= softDeadlineMs')
  }
  ctx.web.registerSearchProvider(new PublicSearchProvider({
    engines: createEngines(engines, userAgent),
    timeoutMs,
    softDeadlineMs,
    hardDeadlineMs,
  }))
}
