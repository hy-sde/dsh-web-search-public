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
import { DEFAULT_USER_AGENT, EngineSearchFailure } from '../src/types.ts'
import type { PublicEngine } from '../src/types.ts'

const ENABLED = process.env.DSH_WEB_SEARCH_REAL_E2E === '1'

describe.skipIf(!ENABLED)('live engines (DSH_WEB_SEARCH_REAL_E2E=1)', () => {
  for (const [name, make] of [
    ['startpage', () => new StartpageEngine(DEFAULT_USER_AGENT)],
    ['duckduckgo', () => new DuckDuckGoEngine(DEFAULT_USER_AGENT)],
    ['mojeek', () => new MojeekEngine(DEFAULT_USER_AGENT)],
  ] as [string, () => PublicEngine][]) {
    it(`${name} returns organic results for a real query`, async (ctx) => {
      try {
        const sources = await make().search({ query: 'deepseek r1 open weights', maxResults: 3 })
        expect(sources.length).toBeGreaterThan(0)
        for (const source of sources) {
          expect(source.url).toMatch(/^https?:\/\//)
        }
      } catch (error) {
        // A live engine may bot-challenge the runner's network at any time; that is
        // an environmental outcome (the engine code classifies it correctly), not a
        // scraper regression. Skip, and only fail on genuine scraper/transport errors.
        if (error instanceof EngineSearchFailure && error.kind === 'challenge') {
          ctx.skip(true, `${name} is bot-challenged from this network right now`)
          return
        }
        throw error
      }
    })
  }

  it('bot-challenged engines fail forward instead of crashing', async () => {
    for (const make of [
      () => new EcosiaEngine(DEFAULT_USER_AGENT),
      () => new GoogleEngine(DEFAULT_USER_AGENT),
    ]) {
      let outcome: 'sources' | 'empty' | 'challenged' = 'sources'
      try {
        const sources = await make().search({ query: 'deepseek', maxResults: 3 })
        if (sources.length === 0) outcome = 'empty'
      } catch (error) {
        if (!(error instanceof EngineSearchFailure)
          || (error.kind !== 'challenge' && error.kind !== 'http')) throw error
        outcome = 'challenged'
      }
      expect(['sources', 'empty', 'challenged']).toContain(outcome)
    }
  })

  it('one run is a full chain pass: at least one engine answers the fan-out', async () => {
    // End-to-end: walk the real engines the same way PublicSearchProvider does —
    // all engines in parallel — and require that at least one organic result is
    // found somewhere in the chain.
    const engines = [
      new StartpageEngine(DEFAULT_USER_AGENT),
      new DuckDuckGoEngine(DEFAULT_USER_AGENT),
      new EcosiaEngine(DEFAULT_USER_AGENT),
      new GoogleEngine(DEFAULT_USER_AGENT),
      new MojeekEngine(DEFAULT_USER_AGENT),
    ]
    const settled = await Promise.allSettled(
      engines.map((engine) => engine.search({ query: 'deepseek', maxResults: 3 })),
    )
    const answered = settled.filter(
      (entry) => entry.status === 'fulfilled' && entry.value.length > 0,
    )
    expect(answered.length).toBeGreaterThan(0)
  })
})
