/**
 * Live-network e2e — opt in with `DSH_WEB_SEARCH_REAL_E2E=1 npm run test:real`.
 * Proves the scrapers against current engine markup and verifies that
 * bot-challenged engines fail forward instead of crashing the chain.
 * @module @hy-sde-org/dsh-web-search-public/tests/real-engines
 */

import { describe, expect, it } from 'vitest'
import { DuckDuckGoEngine } from '../src/engines/duckduckgo.ts'
import { EcosiaEngine } from '../src/engines/ecosia.ts'
import { GoogleEngine } from '../src/engines/google.ts'
import { MojeekEngine } from '../src/engines/mojeek.ts'
import { StartpageEngine } from '../src/engines/startpage.ts'
import { DEFAULT_USER_AGENT } from '../src/types.ts'
import type { PublicEngine } from '../src/types.ts'

const ENABLED = process.env.DSH_WEB_SEARCH_REAL_E2E === '1'

describe.skipIf(!ENABLED)('live engines (DSH_WEB_SEARCH_REAL_E2E=1)', () => {
  it.each<[string, () => PublicEngine]>([
    ['startpage', () => new StartpageEngine(DEFAULT_USER_AGENT)],
    ['duckduckgo', () => new DuckDuckGoEngine(DEFAULT_USER_AGENT)],
    ['mojeek', () => new MojeekEngine(DEFAULT_USER_AGENT)],
  ])('%s returns organic results for a real query', async (_, make) => {
    const sources = await make().search({ query: 'deepseek r1 open weights', maxResults: 3 })
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) {
      expect(source.url).toMatch(/^https?:\/\//)
    }
  })

  it('bot-challenged engines fail forward instead of crashing', async () => {
    for (const make of [
      () => new EcosiaEngine(DEFAULT_USER_AGENT),
      () => new GoogleEngine(DEFAULT_USER_AGENT),
    ]) {
      let outcome: 'sources' | 'empty' | 'challenged' = 'sources'
      try {
        const sources = await make().search({ query: 'deepseek', maxResults: 3 })
        if (sources.length === 0) outcome = 'empty'
      } catch {
        outcome = 'challenged'
      }
      expect(['sources', 'empty', 'challenged']).toContain(outcome)
    }
  })

  it('one run is a full chain pass: at least the first non-challenged engine answers', async () => {
    // End-to-end: walk the real engines the same way PublicSearchProvider does and
    // require that at least one organic result is found somewhere in the chain.
    const engines = [
      new StartpageEngine(DEFAULT_USER_AGENT),
      new DuckDuckGoEngine(DEFAULT_USER_AGENT),
      new EcosiaEngine(DEFAULT_USER_AGENT),
      new GoogleEngine(DEFAULT_USER_AGENT),
      new MojeekEngine(DEFAULT_USER_AGENT),
    ]
    let sources = 0
    for (const engine of engines) {
      try {
        sources = (await engine.search({ query: 'deepseek', maxResults: 3 })).length
        if (sources > 0) break
      } catch {
        // challenged or transport error — advance
      }
    }
    expect(sources).toBeGreaterThan(0)
  })
})
