import type { WebSearchRequest, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Relative publication window accepted by the DSH web-search seam. */
export type SearchRecency = 'day' | 'week' | 'month' | 'year'

/** One free-text term after recognized directives are removed. */
export interface QueryTerm {
  text: string
  phrase?: boolean
  negated?: boolean
  group?: number
}

/** Parsed Google-style search query. */
export interface StructuredQuery {
  raw: string
  text: string
  terms: QueryTerm[]
  sites: string[]
  excludedSites: string[]
  inUrl: string[]
  excludedInUrl: string[]
  inTitle: string[]
  excludedInTitle: string[]
  inText: string[]
  excludedInText: string[]
  filetypes: string[]
  excludedFiletypes: string[]
  after?: string
  before?: string
  lang?: string
  hasDirectives: boolean
  hasConstraints: boolean
}

/** Query-syntax features one public engine accepts. */
export interface QuerySyntax {
  phrases?: boolean
  negation?: boolean
  or?: boolean
  site?: boolean
  inUrl?: boolean
  inTitle?: boolean
  inText?: boolean
  filetype?: boolean
  dateRange?: boolean
}

/** Full classic operator set used by Google-indexed public engines. */
export const GOOGLE_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
  dateRange: true,
}

/** DuckDuckGo HTML supports classic operators except absolute date bounds. */
export const DUCKDUCKGO_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  or: true,
  site: true,
  inUrl: true,
  inTitle: true,
  inText: true,
  filetype: true,
}

/** Mojeek's compatible subset; other constraints are enforced after merge. */
export const MOJEEK_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  site: true,
}

/** Engine request; direct engine callers may omit the shared canonical parse. */
export interface PublicSearchRequest extends WebSearchRequest {
  readonly parsedQuery?: StructuredQuery
  readonly recency?: SearchRecency
}

/** Provider-normalized request shared by every engine and retry. */
export interface NormalizedPublicSearchRequest extends PublicSearchRequest {
  readonly parsedQuery: StructuredQuery
}


/** Result of lenient constraint filtering. */
export interface ConstraintFilterResult {
  sources: WebSearchSource[]
  dropped: string[]
}

interface RawToken {
  text: string
  quoted: boolean
  quotedValue?: boolean
}

type ConstraintField = 'site' | 'inUrl' | 'inTitle' | 'inText' | 'filetype'
type AllMode = 'inTitle' | 'inUrl' | 'inText'

const DIRECTIVE_PATTERN = /^([+-]?)([a-z][a-z-]*):(.*)$/i
const WHITESPACE = /\s/u
const DIRECTIVE_FIELDS: Record<string, ConstraintField | 'before' | 'after' | 'lang'> = {
  site: 'site',
  domain: 'site',
  host: 'site',
  inurl: 'inUrl',
  url: 'inUrl',
  intitle: 'inTitle',
  title: 'inTitle',
  intext: 'inText',
  inbody: 'inText',
  inanchor: 'inText',
  filetype: 'filetype',
  ext: 'filetype',
  before: 'before',
  until: 'before',
  after: 'after',
  since: 'after',
  lang: 'lang',
  language: 'lang',
}
const ALL_MODES: Record<string, AllMode> = {
  allintitle: 'inTitle',
  allinurl: 'inUrl',
  allintext: 'inText',
}
function isQuote(value: string): boolean {
  return value === '"' || value === '\u201c' || value === '\u201d'
}

/** Normalize the public seam request once before retries and engine fan-out. */
export function normalizePublicSearchRequest(request: WebSearchRequest): NormalizedPublicSearchRequest {
  const candidate = (request as WebSearchRequest & { readonly recency?: unknown }).recency
  const recency = candidate === 'day' || candidate === 'week' || candidate === 'month' || candidate === 'year'
    ? candidate
    : undefined
  return {
    ...request,
    parsedQuery: parseSearchQuery(request.query),
    ...recency !== undefined ? { recency } : {},
  }
}

function tokenize(raw: string): RawToken[] {
  const tokens: RawToken[] = []
  let index = 0
  while (index < raw.length) {
    if (WHITESPACE.test(raw[index] as string)) {
      index += 1
      continue
    }
    if (isQuote(raw[index] as string)) {
      let cursor = index + 1
      let text = ''
      while (cursor < raw.length && !isQuote(raw[cursor] as string)) {
        text += raw[cursor]
        cursor += 1
      }
      if (text.trim().length > 0) tokens.push({ text: text.trim(), quoted: true })
      index = cursor + 1
      continue
    }
    let text = ''
    let quotedValue = false
    while (index < raw.length && !WHITESPACE.test(raw[index] as string)) {
      const char = raw[index] as string
      if (isQuote(char) && text.endsWith(':')) {
        let cursor = index + 1
        while (cursor < raw.length && !isQuote(raw[cursor] as string)) {
          text += raw[cursor]
          cursor += 1
        }
        quotedValue = true
        index = cursor + 1
        continue
      }
      if (isQuote(char)) break
      text += char
      index += 1
    }
    if (text.length > 0) tokens.push({ text, quoted: false, quotedValue })
  }
  return splitParens(tokens)
}

function splitParens(tokens: RawToken[]): RawToken[] {
  const output: RawToken[] = []
  for (const token of tokens) {
    if (token.quoted || token.quotedValue) {
      output.push(token)
      continue
    }
    let text = token.text
    while (text.startsWith('(')) {
      output.push({ text: '(', quoted: false })
      text = text.slice(1)
    }
    let trailing = 0
    while (text.endsWith(')')) {
      const body = text.slice(0, -1)
      let depth = 0
      for (const char of body) {
        if (char === '(') depth += 1
        else if (char === ')') depth -= 1
      }
      if (depth > 0) break
      text = body
      trailing += 1
    }
    if (text.length > 0) output.push({ text, quoted: false })
    for (let index = 0; index < trailing; index += 1) output.push({ text: ')', quoted: false })
  }
  return output
}

function isoDate(year: number, month: number, day: number): string | undefined {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Parse supported absolute date spellings into ISO `YYYY-MM-DD`. */
export function parseDateValue(value: string): string | undefined {
  const text = value.trim()
  let match = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(text)
  if (match !== null) {
    return isoDate(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]), match[3] === undefined ? 1 : Number(match[3]))
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text)
  if (match === null) return undefined
  let month = Number(match[1])
  let day = Number(match[2])
  if (month > 12 && day <= 12) [month, day] = [day, month]
  return isoDate(Number(match[3]), month, day)
}

function normalizeSite(value: string): string {
  let site = value.trim().toLowerCase()
  site = site.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  if (site.startsWith('*.')) site = site.slice(2)
  return site.replace(/[/.]+$/, '')
}

function isReservedToken(text: string): boolean {
  if (text === '(' || text === ')' || text === 'OR' || text === 'AND' || text === 'NOT'
    || text === '|' || text === '||' || text === '&&' || text === '!') return true
  const match = DIRECTIVE_PATTERN.exec(text)
  if (match === null) return false
  const name = (match[2] as string).toLowerCase()
  return DIRECTIVE_FIELDS[name] !== undefined || ALL_MODES[name] !== undefined
}

/** Parse Google-style directives while preserving unknown syntax as ordinary text. */
export function parseSearchQuery(raw: string): StructuredQuery {
  const query: StructuredQuery = {
    raw,
    text: '',
    terms: [],
    sites: [],
    excludedSites: [],
    inUrl: [],
    excludedInUrl: [],
    inTitle: [],
    excludedInTitle: [],
    inText: [],
    excludedInText: [],
    filetypes: [],
    excludedFiletypes: [],
    hasDirectives: false,
    hasConstraints: false,
  }
  const tokens = tokenize(raw)
  let negateNext = false
  let orPending = false
  let lastWasTerm = false
  let groupSequence = 0
  let allMode: AllMode | undefined

  const pushConstraint = (field: ConstraintField, value: string, negated: boolean): void => {
    query.hasDirectives = true
    orPending = false
    lastWasTerm = false
    const normalized = value.trim()
    if (normalized.length === 0) return
    if (field === 'site') {
      const site = normalizeSite(normalized)
      if (site.length > 0) (negated ? query.excludedSites : query.sites).push(site)
    } else if (field === 'inUrl') {
      (negated ? query.excludedInUrl : query.inUrl).push(normalized)
    } else if (field === 'inTitle') {
      (negated ? query.excludedInTitle : query.inTitle).push(normalized)
    } else if (field === 'inText') {
      (negated ? query.excludedInText : query.inText).push(normalized)
    } else {
      const extension = normalized.toLowerCase().replace(/^\.+/, '')
      if (extension.length > 0) (negated ? query.excludedFiletypes : query.filetypes).push(extension)
    }
  }

  const pushTerm = (text: string, phrase: boolean): void => {
    const negated = negateNext
    negateNext = false
    if (allMode !== undefined) {
      pushConstraint(allMode, text, negated)
      return
    }
    const term: QueryTerm = { text }
    if (phrase) term.phrase = true
    if (negated) term.negated = true
    if (orPending && lastWasTerm) {
      const previous = query.terms.at(-1)
      if (previous !== undefined) {
        previous.group ??= ++groupSequence
        term.group = previous.group
      }
    }
    orPending = false
    lastWasTerm = true
    query.terms.push(term)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as RawToken
    if (token.quoted) {
      pushTerm(token.text, true)
      continue
    }
    if (token.text === '(' || token.text === ')') continue
    if (token.text === 'OR' || token.text === '|' || token.text === '||') {
      orPending = true
      query.hasDirectives = true
      continue
    }
    if (token.text === 'AND' || token.text === '&&') {
      query.hasDirectives = true
      continue
    }
    if (token.text === 'NOT' || token.text === '!') {
      negateNext = true
      query.hasDirectives = true
      continue
    }
    if (token.text === '-' || token.text === '+') {
      if (token.text === '-' && tokens[index + 1]?.quoted === true) negateNext = true
      continue
    }

    const match = DIRECTIVE_PATTERN.exec(token.text)
    const name = match?.[2]?.toLowerCase()
    const allMatch = name === undefined ? undefined : ALL_MODES[name]
    const field = name === undefined ? undefined : DIRECTIVE_FIELDS[name]
    if (match !== null && allMatch !== undefined) {
      allMode = allMatch
      query.hasDirectives = true
      const inline = (match[3] as string).trim()
      if (inline.length > 0) pushConstraint(allMatch, inline, match[1] === '-')
      orPending = false
      lastWasTerm = false
      continue
    }
    if (match !== null && field !== undefined) {
      let value = (match[3] as string).trim()
      if (value.length === 0) {
        const next = tokens[index + 1]
        if (next !== undefined && (next.quoted || !isReservedToken(next.text))) {
          value = next.text.trim()
          index += 1
        }
      }
      if (value.length === 0) {
        query.hasDirectives = true
        continue
      }
      const negated = match[1] === '-' || negateNext
      negateNext = false
      if (field === 'before' || field === 'after') {
        const date = parseDateValue(value)
        if (date === undefined) {
          pushTerm(token.text, false)
          continue
        }
        if (field === 'before') query.before = date
        else query.after = date
        query.hasDirectives = true
        orPending = false
        lastWasTerm = false
      } else if (field === 'lang') {
        query.lang = value.toLowerCase()
        query.hasDirectives = true
        orPending = false
        lastWasTerm = false
      } else {
        pushConstraint(field, value, negated)
      }
      continue
    }

    let text = token.text
    if (text.startsWith('-') && text.length > 1) {
      negateNext = true
      query.hasDirectives = true
      text = text.replace(/^-+/, '')
      if (text.length === 0) continue
      const negativeMatch = DIRECTIVE_PATTERN.exec(text)
      const negativeName = negativeMatch?.[2]?.toLowerCase()
      const negativeField = negativeName === undefined ? undefined : DIRECTIVE_FIELDS[negativeName]
      if (negativeMatch !== null && negativeField !== undefined
        && negativeField !== 'before' && negativeField !== 'after' && negativeField !== 'lang') {
        negateNext = false
        pushConstraint(negativeField, (negativeMatch[3] as string).trim(), true)
        continue
      }
      pushTerm(text, false)
      continue
    }
    if (text.startsWith('+') && text.length > 1) {
      pushTerm(text.slice(1), true)
      query.hasDirectives = true
      continue
    }
    pushTerm(text, false)
  }

  query.text = renderTerms(query.terms, { phrases: true, negation: true, or: true })
  query.hasConstraints = query.sites.length > 0 || query.excludedSites.length > 0
    || query.inUrl.length > 0 || query.excludedInUrl.length > 0
    || query.inTitle.length > 0 || query.excludedInTitle.length > 0
    || query.filetypes.length > 0 || query.excludedFiletypes.length > 0
    || query.before !== undefined || query.after !== undefined
  return query
}

function renderTerm(term: QueryTerm, syntax: QuerySyntax): string | undefined {
  if (term.negated && !syntax.negation) return undefined
  const value = term.phrase && syntax.phrases ? `"${term.text}"` : term.text
  return term.negated ? `-${value}` : value
}

function renderTerms(terms: readonly QueryTerm[], syntax: QuerySyntax): string {
  const parts: string[] = []
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index] as QueryTerm
    if (term.group !== undefined && syntax.or) {
      const members: string[] = []
      let cursor = index
      for (; cursor < terms.length && terms[cursor]?.group === term.group; cursor += 1) {
        const rendered = renderTerm(terms[cursor] as QueryTerm, syntax)
        if (rendered !== undefined) members.push(rendered)
      }
      index = cursor - 1
      if (members.length > 1) parts.push(`(${members.join(' OR ')})`)
      else if (members.length === 1) parts.push(members[0] as string)
      continue
    }
    const rendered = renderTerm(term, syntax)
    if (rendered !== undefined) parts.push(rendered)
  }
  return parts.join(' ')
}

function quoteValue(value: string): string {
  return /\s/u.test(value) ? `"${value}"` : value
}

/** Format one parsed query for an engine's supported operator syntax. */
export function formatQuery(query: StructuredQuery, syntax: QuerySyntax = {}): string {
  const parts: string[] = []
  const text = renderTerms(query.terms, syntax)
  if (text.length > 0) parts.push(text)
  if (syntax.site) {
    if (query.sites.length > 1 && syntax.or) parts.push(`(${query.sites.map(site => `site:${site}`).join(' OR ')})`)
    else parts.push(...query.sites.map(site => `site:${site}`))
    parts.push(...query.excludedSites.map(site => `-site:${site}`))
  }
  if (syntax.inUrl) {
    parts.push(...query.inUrl.map(value => `inurl:${quoteValue(value)}`))
    parts.push(...query.excludedInUrl.map(value => `-inurl:${quoteValue(value)}`))
  }
  if (syntax.inTitle) {
    parts.push(...query.inTitle.map(value => `intitle:${quoteValue(value)}`))
    parts.push(...query.excludedInTitle.map(value => `-intitle:${quoteValue(value)}`))
  }
  if (syntax.inText) {
    parts.push(...query.inText.map(value => `intext:${quoteValue(value)}`))
    parts.push(...query.excludedInText.map(value => `-intext:${quoteValue(value)}`))
  }
  if (syntax.filetype) {
    if (query.filetypes.length > 1 && syntax.or) {
      parts.push(`(${query.filetypes.map(type => `filetype:${type}`).join(' OR ')})`)
    } else {
      parts.push(...query.filetypes.map(type => `filetype:${type}`))
    }
    parts.push(...query.excludedFiletypes.map(type => `-filetype:${type}`))
  }
  if (syntax.dateRange) {
    if (query.after !== undefined) parts.push(`after:${query.after}`)
    if (query.before !== undefined) parts.push(`before:${query.before}`)
  }
  let result = parts.join(' ').trim()
  if (result.length === 0) {
    result = [...query.sites, ...query.inTitle, ...query.inUrl, ...query.inText, ...query.filetypes].join(' ').trim()
  }
  return result.length > 0 ? result : query.raw.trim()
}

/**
 * Build a public-engine query while demoting path-carrying `site:` and positive
 * `inurl:` constraints that otherwise zero-match across the scraper set.
 */
export function formatScraperQuery(
  query: string,
  parsedQuery: StructuredQuery | undefined,
  syntax: QuerySyntax = GOOGLE_QUERY_SYNTAX,
): string {
  const parsed = parsedQuery ?? parseSearchQuery(query)
  if (!parsed.hasDirectives) return query
  const demoted = [...parsed.sites.filter(site => site.includes('/')), ...parsed.inUrl]
  return formatQuery({
    ...parsed,
    sites: parsed.sites.filter(site => !site.includes('/')),
    inUrl: [],
    terms: [...parsed.terms, ...demoted.map(text => ({ text }))],
  }, syntax)
}

function hostAndPath(value: string): { host: string; path: string } | undefined {
  try {
    const url = new URL(value)
    return { host: url.hostname.toLowerCase(), path: url.pathname }
  } catch {
    return undefined
  }
}

function matchesSite(value: string, site: string): boolean {
  const parsed = hostAndPath(value)
  if (parsed === undefined) return false
  const slash = site.indexOf('/')
  const siteHost = slash === -1 ? site : site.slice(0, slash)
  const sitePath = slash === -1 ? '' : site.slice(slash)
  if (parsed.host !== siteHost && !parsed.host.endsWith(`.${siteHost}`)) return false
  return sitePath.length === 0 || parsed.path.toLowerCase().startsWith(sitePath.toLowerCase())
}

function matchesFiletype(value: string, extension: string): boolean {
  const parsed = hostAndPath(value)
  return parsed !== undefined && parsed.path.toLowerCase().endsWith(`.${extension}`)
}

function sourceTime(source: WebSearchSource): number | undefined {
  if (source.publishedAt === undefined) return undefined
  const value = Date.parse(source.publishedAt)
  return Number.isNaN(value) ? undefined : value
}

interface ConstraintDimension {
  label: string
  predicate: (source: WebSearchSource) => boolean
}

function constraintDimensions(query: StructuredQuery): ConstraintDimension[] {
  const dimensions: ConstraintDimension[] = []
  const lower = (value: string | undefined): string => value?.toLowerCase() ?? ''
  if (query.sites.length > 0) dimensions.push({
    label: query.sites.map(site => `site:${site}`).join(' OR '),
    predicate: source => query.sites.some(site => matchesSite(source.url, site)),
  })
  if (query.excludedSites.length > 0) dimensions.push({
    label: query.excludedSites.map(site => `-site:${site}`).join(' '),
    predicate: source => !query.excludedSites.some(site => matchesSite(source.url, site)),
  })
  if (query.inUrl.length > 0) dimensions.push({
    label: query.inUrl.map(value => `inurl:${value}`).join(' '),
    predicate: source => query.inUrl.every(value => lower(source.url).includes(value.toLowerCase())),
  })
  if (query.excludedInUrl.length > 0) dimensions.push({
    label: query.excludedInUrl.map(value => `-inurl:${value}`).join(' '),
    predicate: source => !query.excludedInUrl.some(value => lower(source.url).includes(value.toLowerCase())),
  })
  if (query.inTitle.length > 0) dimensions.push({
    label: query.inTitle.map(value => `intitle:${value}`).join(' '),
    predicate: source => query.inTitle.every(value => lower(source.title).includes(value.toLowerCase())),
  })
  if (query.excludedInTitle.length > 0) dimensions.push({
    label: query.excludedInTitle.map(value => `-intitle:${value}`).join(' '),
    predicate: source => !query.excludedInTitle.some(value => lower(source.title).includes(value.toLowerCase())),
  })
  if (query.filetypes.length > 0) dimensions.push({
    label: query.filetypes.map(type => `filetype:${type}`).join(' OR '),
    predicate: source => query.filetypes.some(type => matchesFiletype(source.url, type)),
  })
  if (query.excludedFiletypes.length > 0) dimensions.push({
    label: query.excludedFiletypes.map(type => `-filetype:${type}`).join(' '),
    predicate: source => !query.excludedFiletypes.some(type => matchesFiletype(source.url, type)),
  })
  if (query.after !== undefined || query.before !== undefined) {
    const after = query.after === undefined ? undefined : Date.parse(query.after)
    const before = query.before === undefined ? undefined : Date.parse(query.before)
    dimensions.push({
      label: [query.after === undefined ? '' : `after:${query.after}`, query.before === undefined ? '' : `before:${query.before}`]
        .filter(Boolean).join(' '),
      predicate: (source) => {
        const time = sourceTime(source)
        if (time === undefined) return true
        if (after !== undefined && time < after) return false
        return before === undefined || time < before
      },
    })
  }
  return dimensions
}

/**
 * Apply each observable constraint independently. A dimension that would erase
 * every remaining source is relaxed and reported instead of producing an empty
 * result from an otherwise successful search.
 */
export function applyQueryConstraints(
  sources: readonly WebSearchSource[],
  query: StructuredQuery,
): ConstraintFilterResult {
  let current = [...sources]
  const dropped: string[] = []
  if (current.length === 0) return { sources: current, dropped }
  for (const dimension of constraintDimensions(query)) {
    const kept = current.filter(dimension.predicate)
    if (kept.length > 0) current = kept
    else dropped.push(dimension.label)
  }
  return { sources: current, dropped }
}
