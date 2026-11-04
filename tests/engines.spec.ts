/**
 * Contract tests for the per-engine HTML parsers and href unwrappers.
 * @module @hy-sde-org/dsh-web-search-public/tests/engines
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { looksLikeChallengePage } from '../src/engines/challenge.ts'
import { DuckDuckGoEngine, parseDuckDuckGo, unwrapDdgHref } from '../src/engines/duckduckgo.ts'
import { EcosiaEngine, parseEcosia, isBlockedPage } from '../src/engines/ecosia.ts'
import { GoogleEngine, parseGoogle, unwrapGoogleHref, blockReason } from '../src/engines/google.ts'
import { MojeekEngine, parseMojeek, isRobotPage } from '../src/engines/mojeek.ts'
import { collectHiddenInputs, parseStartpage } from '../src/engines/startpage.ts'

describe('unwrapDdgHref', () => {
  it('unwraps a uddg redirect (entity-decoded href)', () => {
    expect(unwrapDdgHref('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs&rut=123'))
      .toBe('https://example.org/docs')
  })

  it('passes through a plain http(s) href', () => {
    expect(unwrapDdgHref('https://plain.test/page')).toBe('https://plain.test/page')
  })

  it('rejects non-http hrefs', () => {
    expect(unwrapDdgHref('javascript:alert(1)')).toBeUndefined()
    expect(unwrapDdgHref('')).toBeUndefined()
  })
})

describe('parseDuckDuckGo', () => {
  const page = [
    '<div class="result results_links_deep web-result">',
    '  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs&amp;rut=123">Example Docs</a>',
    '  <div class="result__snippet">Everything about <b>examples</b>.</div>',
    '  <a rel="nofollow" class="result__timestamp">2026-05-01T00:00:00.0000000</a>',
    '</div>',
    '<div class="result">',
    '  <a rel="nofollow" class="result__a" href="https://plain.test/page">Plain Result</a>',
    '  <a rel="nofollow" class="result__snippet">A plain snippet.</a>',
    '</div>',
  ].join('')

  it('parses title, unwrapped url, snippet and publishedAt', () => {
    const sources = parseDuckDuckGo(page, 10)
    expect(sources).toHaveLength(2)
    const first = sources[0]!
    expect(first).toEqual({
      url: 'https://example.org/docs',
      title: 'Example Docs',
      snippet: 'Everything about examples.',
      publishedAt: '2026-05-01',
    })
    const second = sources[1]!
    expect(second.url).toBe('https://plain.test/page')
    expect(second.title).toBe('Plain Result')
    expect(second.snippet).toBe('A plain snippet.')
    expect(second.publishedAt).toBeUndefined()
  })

  it('respects the limit', () => {
    expect(parseDuckDuckGo(page, 1)).toHaveLength(1)
  })

  it('skips paid y.js ad rows', () => {
    const withAd = [
      '<div class="result">',
      '  <a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=spam.test&amp;ad_provider=bingv7aa&amp;uddg=https%3A%2F%2Fads.spam.test%2Fbuy&amp;rut=1">Sponsored Spam</a>',
      '  <div class="result__snippet">Buy now.</div>',
      '</div>',
      '<div class="result">',
      '  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fok&amp;rut=2">Real Result</a>',
      '</div>',
    ].join('')
    const sources = parseDuckDuckGo(withAd, 10)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.url).toBe('https://example.org/ok')
  })
})

describe('collectHiddenInputs', () => {
  const page = [
    '<form>',
    '<input type="hidden" name="sc" value="token1">',
    '<input name="lifetime" value="forever">',
    '<input type="text" name="query" value="ignored">',
    '<input type="submit" value="go">',
    '<input type="checkbox" name="c" value="1">',
    '</form>',
  ].join('')

  it('keeps hidden or typeless named fields, drops the query field and visible controls', () => {
    expect(collectHiddenInputs(page)).toEqual({ sc: 'token1', lifetime: 'forever' })
  })
})

describe('parseStartpage', () => {
  const page = [
    '<div class="result">',
    '  <a class="result-title result-link" href="https://startpage.test/a">Startpage A</a>',
    '  <p class="description">First description here.</p>',
    '</div>',
    '<div class="result">',
    '  <a class="result-title result-link" href="https://startpage.test/b">Startpage B</a>',
    '  <p class="description">Second description.</p>',
    '</div>',
  ].join('')

  it('parses title, url and description', () => {
    const sources = parseStartpage(page, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({
      url: 'https://startpage.test/a',
      title: 'Startpage A',
      snippet: 'First description here.',
    })
    expect(sources[1]!.url).toBe('https://startpage.test/b')
  })
})

describe('parseEcosia', () => {
  const page = [
    '<div id="results">',
    '  <article class="result">',
    '    <a class="result__a" href="https://ecosia.test/one" >Ecosia One</a>',
    '    <p class="result__quote">Ecosia snippet one.</p>',
    '  </article>',
    '  <article class="result">',
    '    <a class="result__a" href="https://ecosia.test/two">Ecosia Two</a>',
    '    <p class="result__quote">Ecosia snippet two.</p>',
    '  </article>',
    '</div>',
  ].join('')

  it('parses result links with quoted snippets, deduped by url', () => {
    const sources = parseEcosia(page, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://ecosia.test/one', title: 'Ecosia One', snippet: 'Ecosia snippet one.' })
    expect(sources[1]).toEqual({ url: 'https://ecosia.test/two', title: 'Ecosia Two', snippet: 'Ecosia snippet two.' })
  })

  it('pairs snippets by page position when a result lacks one (no misattribution)', () => {
    const sparse = [
      '<div id="results">',
      '  <article class="result">',
      '    <a class="result__a" href="https://ecosia.test/first">Ecosia First</a>',
      '  </article>',
      '  <article class="result">',
      '    <a class="result__a" href="https://ecosia.test/second">Ecosia Second</a>',
      '    <p class="result__quote">Second snippet only.</p>',
      '  </article>',
      '</div>',
    ].join('')
    const sources = parseEcosia(sparse, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://ecosia.test/first', title: 'Ecosia First' })
    expect(sources[1]).toEqual({ url: 'https://ecosia.test/second', title: 'Ecosia Second', snippet: 'Second snippet only.' })
  })

  it("does not leak a filtered card's snippet into the previous result's window", () => {
    // The middle card has an invalid href (filtered out) but its own snippet.
    // Snippet windows must close at its anchor even though it emits no result.
    const sparse = [
      '<div id="results">',
      '  <article class="result">',
      '    <a class="result__a" href="https://ecosia.test/first">Ecosia First</a>',
      '  </article>',
      '  <article class="result">',
      '    <a class="result__a" href="javascript:void(0)">Ecosia Card</a>',
      '    <p class="result__quote">Card snippet.</p>',
      '  </article>',
      '  <article class="result">',
      '    <a class="result__a" href="https://ecosia.test/third">Ecosia Third</a>',
      '    <p class="result__quote">Third snippet.</p>',
      '  </article>',
      '</div>',
    ].join('')
    const sources = parseEcosia(sparse, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://ecosia.test/first', title: 'Ecosia First' })
    expect(sources[1]).toEqual({ url: 'https://ecosia.test/third', title: 'Ecosia Third', snippet: 'Third snippet.' })
  })
})

describe('unwrapGoogleHref', () => {
  it('unwraps a /url?q= redirect (entity-decoded href)', () => {
    expect(unwrapGoogleHref('/url?q=https%3A%2F%2Fg.test%2Fone&sa=U&ved=0')).toBe('https://g.test/one')
  })

  it('passes through a plain http(s) href and rejects junk', () => {
    expect(unwrapGoogleHref('https://g.test/two')).toBe('https://g.test/two')
    expect(unwrapGoogleHref('javascript:void(0)')).toBeUndefined()
  })
})

describe('parseGoogle', () => {
  const page = [
    '<div id="search">',
    '  <div class="g">',
    '    <a href="/url?q=https%3A%2F%2Fg.test%2Fone&amp;sa=U&amp;ved=0"><h3 class="LC20lb">Google One</h3></a>',
    '    <div class="VwiC3b">Google snippet one.</div>',
    '  </div>',
    '  <div class="g">',
    '    <a href="https://g.test/two"><h3>Google Two</h3></a>',
    '    <div class="VwiC3b yXK7x">Google snippet two.</div>',
    '  </div>',
    '</div>',
  ].join('')

  it('keeps only anchors wrapping an h3, unwraps /url?q, pairs VwiC3b snippets', () => {
    const sources = parseGoogle(page, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({
      url: 'https://g.test/one',
      title: 'Google One',
      snippet: 'Google snippet one.',
    })
    expect(sources[1]).toEqual({
      url: 'https://g.test/two',
      title: 'Google Two',
      snippet: 'Google snippet two.',
    })
  })

  it('does not treat non-h3 anchors as results', () => {
    const withAd = [
      '<div id="search">',
      '  <div class="g">',
      '    <a class="tads-link" href="https://ads.test/buy"><span>Sponsored buy</span></a>',
      '    <a href="https://g.test/real"><h3>Real Result</h3></a>',
      '  </div>',
      '</div>',
    ].join('')
    const sources = parseGoogle(withAd, 10)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.url).toBe('https://g.test/real')
  })

  it('does not backtrack catastrophically on an unclosed anchor of single-quoted attributes', () => {
    // The anchor attribute regex must stay quote-aware: with `[^>"]` the
    // unrestricted alternative and the single-quoted alternative both consume
    // `'`, and an unclosed anchor backtracks exponentially (and SYNCHRONOUSLY
    // — no deadline can interrupt a hung regex on the event loop).
    const hostile = '<div id="search"><a href=' + "'x' ".repeat(24) + '>unclosed'.repeat(8)
    const startedAt = Date.now()
    const sources = parseGoogle(hostile, 10)
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(sources).toEqual([])
  })

  it('pairs snippets by page position when a result lacks one (no misattribution)', () => {
    const sparse = [
      '<div id="search">',
      '  <div class="g">',
      '    <a href="https://g.test/first"><h3>First</h3></a>',
      '  </div>',
      '  <div class="g">',
      '    <a href="https://g.test/second"><h3>Second</h3></a>',
      '    <div class="VwiC3b">Second snippet only.</div>',
      '  </div>',
      '</div>',
    ].join('')
    const sources = parseGoogle(sparse, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://g.test/first', title: 'First' })
    expect(sources[1]).toEqual({ url: 'https://g.test/second', title: 'Second', snippet: 'Second snippet only.' })
  })

  it("does not leak a filtered card's snippet into the previous result's window", () => {
    const sparse = [
      '<div id="search">',
      '  <div class="g">',
      '    <a href="https://g.test/first"><h3>First</h3></a>',
      '  </div>',
      '  <div class="g">',
      '    <a href="javascript:void(0)"><h3>Card</h3></a>',
      '    <div class="VwiC3b">Card snippet.</div>',
      '  </div>',
      '  <div class="g">',
      '    <a href="https://g.test/third"><h3>Third</h3></a>',
      '    <div class="VwiC3b">Third snippet.</div>',
      '  </div>',
      '</div>',
    ].join('')
    const sources = parseGoogle(sparse, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://g.test/first', title: 'First' })
    expect(sources[1]).toEqual({ url: 'https://g.test/third', title: 'Third', snippet: 'Third snippet.' })
  })
})

describe('parseMojeek', () => {
  const page = [
    '<ul id="item" class="results-standard">',
    '  <li>',
    '    <h2><a href="https://m.test/one">Mojeek One</a></h2>',
    '    <p class="s">Mojeek snippet one.</p>',
    '  </li>',
    '  <li>',
    '    <h2><a href="https://m.test/two">Mojeek Two</a></h2>',
    '    <p class="s">Mojeek snippet two.</p>',
    '  </li>',
    '  <li>', // suggested-site alternative result (no h2 anchor)
    '    <a href="https://m.test/alt">Alt link</a>',
    '  </li>',
    '</ul>',
  ].join('')

  it('parses h2-anchored results with p.s snippets and skips non-h2 items', () => {
    const sources = parseMojeek(page, 10)
    expect(sources).toHaveLength(2)
    expect(sources[0]).toEqual({ url: 'https://m.test/one', title: 'Mojeek One', snippet: 'Mojeek snippet one.' })
    expect(sources[1]).toEqual({ url: 'https://m.test/two', title: 'Mojeek Two', snippet: 'Mojeek snippet two.' })
  })

  it('returns an empty list when no results-standard list exists', () => {
    expect(parseMojeek('<ul class="results-other"></ul>', 10)).toEqual([])
  })
})

describe('bot-wall predicates', () => {
  it('classifies Google enable-JS and traffic walls', () => {
    expect(blockReason({ html: '<script src="/httpservice/retry/enablejs"></script>', status: 200, url: 'https://www.google.com/search' }))
      .toBe('javascript')
    expect(blockReason({ html: '<html></html>', status: 403, url: 'https://www.google.com/search' })).toBe('traffic')
    expect(blockReason({ html: 'Unusual traffic', status: 200, url: 'https://www.google.com/search' })).toBe('traffic')
    expect(blockReason({ html: '<div id="search"><a href="/url?q=x"><h3>ok</h3></a></div>', status: 200, url: 'u' }))
      .toBeUndefined()
  })

  it('classifies Ecosia Cloudflare firewall pages', () => {
    expect(isBlockedPage({ html: '<title>Ecosia Firewall</title>', status: 200, url: 'u' })).toBe(true)
    expect(isBlockedPage({ html: '<html>_cf_chl_opt</html>', status: 403, url: 'u' })).toBe(true)
    expect(isBlockedPage({ html: '<article class="result__a"></article>', status: 200, url: 'u' })).toBe(false)
  })

  it('classifies Mojeek ALTCHA walls only when results are absent', () => {
    expect(isRobotPage({ html: '<div id="altcha-widget"></div>', status: 200, url: 'u' })).toBe(true)
    expect(isRobotPage({ html: 'Sending automated queries', status: 403, url: 'u' })).toBe(true)
    expect(isRobotPage({ html: '<ul class="results-standard"><li>x</li></ul>', status: 200, url: 'u' })).toBe(false)
  })
})

describe('looksLikeChallengePage', () => {
  it('recognizes common bot-wall signatures', () => {
    expect(looksLikeChallengePage('<div id="px-captcha"></div>')).toBe(true)
    expect(looksLikeChallengePage('<div class="captcha-wrap"></div>')).toBe(true)
    expect(looksLikeChallengePage('<altcha-widget></altcha-widget>')).toBe(true)
    expect(looksLikeChallengePage('Unfortunately, bots use DuckDuckGo too.')).toBe(true)
    expect(looksLikeChallengePage('<script src="/cdn-cgi/challenge-platform/h/g/orchestrate"></script>')).toBe(true)
    expect(looksLikeChallengePage('<div class="g-recaptcha"></div>')).toBe(true)
    expect(looksLikeChallengePage('unusual traffic from your computer network')).toBe(true)
  })

  it('does not flag ordinary pages', () => {
    expect(looksLikeChallengePage('<html><body>No results found</body></html>')).toBe(false)
    expect(looksLikeChallengePage('')).toBe(false)
  })

  it('does not flag a no-results page that merely echoes wall terms as the query', () => {
    // Search pages echo the query inside the title and form controls. Bare
    // terms like "perimeterx" must never classify a page — only structural
    // wall markers do.
    const query = 'site:example.invalid perimeterx'
    const page = `<html><head><title>${query} - Startpage.com</title></head><body>`
      + `<form method="post" action="/sp/search"><input type="text" name="query" value="${query}">`
      + `<p>No results. Try different keywords.</p></body></html>`
    expect(looksLikeChallengePage(page)).toBe(false)
    expect(looksLikeChallengePage('perimeterx')).toBe(false)
  })
})

describe('DuckDuckGoEngine', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a 200 challenge form as a structured challenge instead of an accepted empty page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unfortunately, bots use DuckDuckGo too.', { status: 200 })))
    const engine = new DuckDuckGoEngine('test-agent')
    await expect(engine.search({ query: 'anything' }, undefined))
      .rejects.toMatchObject({ kind: 'challenge' })
  })
})

describe('browser-backed engines without a scraper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // createEngines() supports omitting the scraper. Escalation is then
  // unavailable, but a KNOWN block page must still classify as a challenge —
  // never degrade into a successful empty search.
  it('google classifies its enablejs wall as a challenge without a scraper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><head><meta http-equiv="refresh" content="0; url=/httpservice/retry/enablejs"></head>'
        + '<body><p>JavaScript is disabled.</p></body></html>',
      { status: 200 },
    )))
    const engine = new GoogleEngine('test-agent')
    await expect(engine.search({ query: 'anything' }, undefined))
      .rejects.toMatchObject({ kind: 'challenge' })
  })

  it('ecosia classifies its firewall page as a challenge without a scraper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>Ecosia Firewall</body></html>', { status: 200 })))
    const engine = new EcosiaEngine('test-agent')
    await expect(engine.search({ query: 'anything' }, undefined))
      .rejects.toMatchObject({ kind: 'challenge' })
  })

  it('mojeek classifies its robot page as a challenge without a scraper', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<html><body>Sending automated queries to our service is not allowed.</body></html>',
      { status: 200 },
    )))
    const engine = new MojeekEngine('test-agent')
    await expect(engine.search({ query: 'anything' }, undefined))
      .rejects.toMatchObject({ kind: 'challenge' })
  })
})
