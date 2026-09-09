/**
 * Engine factory for `@hy-sde-org/dsh-web-search-public`.
 * @module @hy-sde-org/dsh-web-search-public/engines
 */

import type { PublicEngine, PublicEngineId } from '../types.ts'
import { DuckDuckGoEngine } from './duckduckgo.ts'
import { EcosiaEngine } from './ecosia.ts'
import { GoogleEngine } from './google.ts'
import { MojeekEngine } from './mojeek.ts'
import { StartpageEngine } from './startpage.ts'

type EngineFactory = (userAgent: string) => PublicEngine

const ENGINE_FACTORIES: Record<string, EngineFactory> = {
  startpage: userAgent => new StartpageEngine(userAgent),
  duckduckgo: userAgent => new DuckDuckGoEngine(userAgent),
  ecosia: userAgent => new EcosiaEngine(userAgent),
  google: userAgent => new GoogleEngine(userAgent),
  mojeek: userAgent => new MojeekEngine(userAgent),
}

/** Build engines in the requested order, silently dropping unknown or duplicate ids. */
export function createEngines(ids: readonly PublicEngineId[], userAgent: string): PublicEngine[] {
  const engines: PublicEngine[] = []
  const seen = new Set<PublicEngineId>()
  for (const id of ids) {
    const factory = ENGINE_FACTORIES[id]
    if (factory === undefined || seen.has(id)) continue
    seen.add(id)
    engines.push(factory(userAgent))
  }
  return engines
}
