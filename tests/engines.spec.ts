/**
 * Contract tests for the per-engine HTML parsers and href unwrappers.
 * @module @hy-sde-org/dsh-web-search-public/tests/engines
 */

import { describe, expect, it } from 'vitest'
import { parseDuckDuckGo, unwrapDdgHref } from '../src/engines/duckduckgo.ts'
import { parseEcosia } from '../src/engines/ecosia.ts'
import { parseGoogle, unwrapGoogleHref } from '../src/engines/google.ts'
import { parseMojeek } from '../src/engines/mojeek.ts'
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
