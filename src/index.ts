/**
 * `@hy-sde-org/dsh-web-search-public`: registers a credential-free `WebSearchProvider`
 * with `ctx.web`. A function/namespace plugin (NOT a default-export service): a
 * search provider does not own the `ctx.web` key — it registers INTO the seam's
 * provider registry, like the other `dsh-web-search-*` packages. The provider
 * chains the anonymous engines in order (Startpage → DuckDuckGo → Ecosia →
 * Google → Mojeek) and returns the first engine that yields sources, so no API
 * key or credential is required.
 * @module @hy-sde-org/dsh-web-search-public
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { createEngines } from './engines/index.ts'
import { PublicSearchProvider } from './provider.ts'
import type { PublicEngineId } from './types.ts'
import {
  DEFAULT_ENGINE_ORDER,
  DEFAULT_ENGINE_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  PUBLIC_ENGINE_IDS,
} from './types.ts'

export { PUBLIC_PROVIDER_ID, PublicSearchProvider } from './provider.ts'
export type { PublicSearchProviderOptions } from './provider.ts'
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
  /** Per-engine transport timeout (ms). Default: 10000. The chain's worst case is engines.length × timeoutMs. */
  timeoutMs?: number
  /** Engine ids tried in order; unlisted engines stay disabled. Default: startpage, duckduckgo, ecosia, google, mojeek. */
  engines?: PublicEngineId[]
  /** User-Agent sent to the engines. Defaults to a browser-shaped constant. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_ENGINE_TIMEOUT_MS),
  engines: z.array(z.union(PUBLIC_ENGINE_IDS)).default([...DEFAULT_ENGINE_ORDER]),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})
/** Register the credential-free public search provider with `ctx.web`. */
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
  ctx.web.registerSearchProvider(new PublicSearchProvider({
    engines: createEngines(engines, userAgent),
    timeoutMs,
  }))
}
