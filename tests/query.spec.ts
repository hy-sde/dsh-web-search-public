import { describe, expect, it } from 'vitest'
import {
  applyQueryConstraints,
  DUCKDUCKGO_QUERY_SYNTAX,
  formatScraperQuery,
  parseSearchQuery,
} from '../src/query.ts'

describe('public search query controls', () => {
  it('canonicalizes aliases and formats only syntax the target engine supports', () => {
    const raw = 'release domain:example.com intitle:"API guide" since:2026-01 filetype:pdf'
    const parsed = parseSearchQuery(raw)

    expect(formatScraperQuery(raw, parsed)).toBe(
      'release site:example.com intitle:"API guide" filetype:pdf after:2026-01-01',
    )
    expect(formatScraperQuery(raw, parsed, DUCKDUCKGO_QUERY_SYNTAX)).toBe(
      'release site:example.com intitle:"API guide" filetype:pdf',
    )
  })

  it('keeps unknown and malformed directives as search terms', () => {
    const raw = 'TS2345: failure before:someday https://example.com/docs'
    const parsed = parseSearchQuery(raw)

    expect(parsed.before).toBeUndefined()
    expect(parsed.text).toBe(raw)
  })

  it('filters observable dimensions after merge without treating undated sources as stale', () => {
    const parsed = parseSearchQuery('guide site:example.com intitle:API filetype:pdf after:2026-01-01')
    const result = applyQueryConstraints([
      { url: 'https://example.com/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
      { url: 'https://example.com/api.pdf?mirror=1', title: 'API Guide' },
      { url: 'https://other.test/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
      { url: 'https://example.com/old.pdf', title: 'API Guide', publishedAt: '2025-01-01' },
    ], parsed)

    expect(result).toEqual({
      sources: [
        { url: 'https://example.com/api.pdf', title: 'API Guide', publishedAt: '2026-02-01' },
        { url: 'https://example.com/api.pdf?mirror=1', title: 'API Guide' },
      ],
      dropped: [],
    })
  })

  it('relaxes only a constraint dimension that would erase every source', () => {
    const parsed = parseSearchQuery('guide site:missing.test -site:blocked.test')
    const sources = [
      { url: 'https://allowed.test/guide', title: 'Guide' },
      { url: 'https://blocked.test/guide', title: 'Guide' },
    ]

    expect(applyQueryConstraints(sources, parsed)).toEqual({
      sources: [{ url: 'https://allowed.test/guide', title: 'Guide' }],
      dropped: ['site:missing.test'],
    })
  })
})
