/**
 * Engine factory for `@hy-sde-org/dsh-web-search-public`.
 * @module @hy-sde-org/dsh-web-search-public/engines
 */

import type { PublicEngine, PublicEngineId } from '../types.ts'
import type { PageScraper } from './browser-page.ts'
import { DuckDuckGoEngine } from './duckduckgo.ts'
import { EcosiaEngine } from './ecosia.ts'
import { GoogleEngine } from './google.ts'
import { MojeekEngine } from './mojeek.ts'
import { StartpageEngine } from './startpage.ts'

type EngineFactory = (userAgent: string, scraper?: PageScraper) => PublicEngine

const ENGINE_FACTORIES: Record<string, EngineFactory> = {
  startpage: userAgent => new StartpageEngine(userAgent),
  duckduckgo: userAgent => new DuckDuckGoEngine(userAgent),
  ecosia: (userAgent, scraper) => new EcosiaEngine(userAgent, scraper),
  google: (userAgent, scraper) => new GoogleEngine(userAgent, scraper),
  mojeek: (userAgent, scraper) => new MojeekEngine(userAgent, scraper),
}

/** Build engines in the requested order, silently dropping unknown or duplicate ids. */
export function createEngines(ids: readonly PublicEngineId[], userAgent: string, scraper?: PageScraper): PublicEngine[] {
  const engines: PublicEngine[] = []
  const seen = new Set<PublicEngineId>()
  for (const id of ids) {
    const factory = ENGINE_FACTORIES[id]
    if (factory === undefined || seen.has(id)) continue
    seen.add(id)
    engines.push(factory(userAgent, scraper))
  }
  return engines
}
