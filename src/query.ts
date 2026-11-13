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

/** One same-field OR chain parsed from explicit Boolean syntax (`intitle:a OR intitle:b`). */
export interface ConstraintOrGroup {
  field: ConstraintField
  values: string[]
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
  /** Explicit same-field OR chains between positive directives. */
  orGroups: ConstraintOrGroup[]
  after?: string
  before?: string
  lang?: string
  hasDirectives: boolean
  hasConstraints: boolean
  /**
   * True when the query uses Boolean structure the flat constraint model
   * cannot represent exactly (parentheses, cross-field OR, negated OR
   * chains): engines receive the raw text unchanged and local constraint
   * filtering is skipped rather than rewriting the Boolean meaning.
   */
  verbatim: boolean
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

/**
 * Return strict constraints an engine cannot enforce and the merged result
 * cannot verify from URL/title metadata.
 */
export function unsupportedQueryConstraints(
  query: StructuredQuery,
  syntax: QuerySyntax | undefined,
): string[] {
  if (syntax === undefined || query.verbatim) return []
  const unsupported: string[] = []
  if (!syntax.inText && (query.inText.length > 0 || query.excludedInText.length > 0)) {
    unsupported.push([
      ...query.inText.map(value => `intext:${quoteValue(value)}`),
      ...query.excludedInText.map(value => `-intext:${quoteValue(value)}`),
    ].join(' '))
  }
  if (!syntax.dateRange && (query.after !== undefined || query.before !== undefined)) {
    unsupported.push([
      query.after === undefined ? '' : `after:${query.after}`,
      query.before === undefined ? '' : `before:${query.before}`,
    ].filter(Boolean).join(' '))
  }
  return unsupported
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


/** Result of constraint filtering: kept sources, relaxed dimensions, and any dimension that emptied the result. */
export interface ConstraintFilterResult {
  sources: WebSearchSource[]
  /** Labels of positive dimensions relaxed under `relaxPositive`. */
  dropped: string[]
  /** Label of the constraint that excluded every returned source (reported, never silently relaxed). */
  emptiedBy?: string
}

interface RawToken {
  text: string
  quoted: boolean
  quotedValue?: boolean
}

/** Constraint fields with local observable predicates (see {@link constraintDimensions}). */
export type ConstraintField = 'site' | 'inUrl' | 'inTitle' | 'inText' | 'filetype'
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
    orGroups: [],
    hasDirectives: false,
    hasConstraints: false,
    verbatim: false,
  }
  const tokens = tokenize(raw)
  let negateNext = false
  let orPending = false
  let lastWasTerm = false
  let groupSequence = 0
  let allMode: AllMode | undefined
  // Boolean-structure tracking: `verbatim` marks queries whose Boolean meaning
  // the flat constraint model cannot represent exactly (parens, cross-field
  // OR, negated OR chains) — engines then receive the raw text unchanged.
  let verbatim = false
  let lastConstraint: { field: ConstraintField; negated: boolean; value: string } | undefined
  let openGroup: ConstraintOrGroup | undefined

  const flatArrayOf = (field: ConstraintField): string[] =>
    field === 'site'
      ? query.sites
      : field === 'inUrl'
        ? query.inUrl
        : field === 'inTitle'
          ? query.inTitle
          : field === 'inText'
            ? query.inText
            : query.filetypes

  const pushConstraint = (field: ConstraintField, value: string, negated: boolean, chained = false): void => {
    query.hasDirectives = true
    orPending = false
    lastWasTerm = false
    const normalized = value.trim()
    if (normalized.length === 0) return
    let stored = normalized
    if (field === 'site') {
      stored = normalizeSite(normalized)
      if (stored.length === 0) return
    } else if (field === 'filetype') {
      stored = normalized.toLowerCase().replace(/^\.+/, '')
      if (stored.length === 0) return
    }
    if (chained && !verbatim) {
      if (!negated) {
        // An explicit OR chain is representable only between same-field
        // positive directives: continue an open chain, or convert a flat
        // same-field predecessor into a new chain.
        if (openGroup !== undefined && openGroup.field === field) {
          openGroup.values.push(stored)
          lastConstraint = { field, negated: false, value: stored }
          return
        }
        const previous = lastConstraint
        if (previous !== undefined && previous.field === field && !previous.negated
          && flatArrayOf(field).at(-1) === previous.value) {
          flatArrayOf(field).pop()
          openGroup = { field, values: [previous.value, stored] }
          query.orGroups.push(openGroup)
          lastConstraint = { field, negated: false, value: stored }
          return
        }
      }
      // Anything else chained — cross-field OR, negated directives in a chain,
      // a chain broken by an ungroupable predecessor — is Boolean structure
      // the flat model cannot represent: pass it through verbatim.
      verbatim = true
      openGroup = undefined
      lastConstraint = undefined
      return
    }
    openGroup = undefined
    lastConstraint = { field, negated, value: stored }
    if (field === 'site') {
      (negated ? query.excludedSites : query.sites).push(stored)
    } else if (field === 'inUrl') {
      (negated ? query.excludedInUrl : query.inUrl).push(stored)
    } else if (field === 'inTitle') {
      (negated ? query.excludedInTitle : query.inTitle).push(stored)
    } else if (field === 'inText') {
      (negated ? query.excludedInText : query.inText).push(stored)
    } else {
      (negated ? query.excludedFiletypes : query.filetypes).push(stored)
    }
  }

  const pushTerm = (text: string, phrase: boolean, chained = false): void => {
    const negated = negateNext
    negateNext = false
    if (allMode !== undefined) {
      // All-mode values are constraints; an OR between them follows the same
      // same-field-positive chain rules as directive chains.
      pushConstraint(allMode, text, negated, chained)
      return
    }
    if (chained && !lastWasTerm && lastConstraint !== undefined) {
      // A term joined by OR to a preceding directive is Boolean structure the
      // flat model cannot represent — pass the expression through verbatim.
      verbatim = true
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
    openGroup = undefined
    query.terms.push(term)
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as RawToken
    if (token.quoted) {
      pushTerm(token.text, true, orPending)
      continue
    }
    if (token.text === '(' || token.text === ')') {
      // Parentheses change operator precedence in ways the flat constraint
      // model cannot represent — pass the raw expression through unchanged.
      verbatim = true
      continue
    }
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
      if (orPending) {
        // An OR pointing at an all-mode directive has no flat representation.
        verbatim = true
      }
      allMode = allMatch
      query.hasDirectives = true
      const inline = (match[3] as string).trim()
      if (inline.length > 0) pushConstraint(allMatch, inline, match[1] === '-')
      orPending = false
      lastWasTerm = false
      continue
    }
    if (match !== null && field !== undefined) {
      const chained = orPending
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
        if (chained) {
          // An OR chain over date bounds has no conjunctive representation.
          verbatim = true
          continue
        }
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
        openGroup = undefined
        lastConstraint = undefined
      } else if (field === 'lang') {
        if (chained) {
          verbatim = true
          continue
        }
        query.lang = value.toLowerCase()
        query.hasDirectives = true
        orPending = false
        lastWasTerm = false
        openGroup = undefined
        lastConstraint = undefined
      } else {
        pushConstraint(field, value, negated, chained)
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
        pushConstraint(negativeField, (negativeMatch[3] as string).trim(), true, orPending)
        continue
      }
      pushTerm(text, false, orPending)
      continue
    }
    if (text.startsWith('+') && text.length > 1) {
      pushTerm(text.slice(1), true, orPending)
      query.hasDirectives = true
      continue
    }
    pushTerm(text, false, orPending)
  }

  query.text = renderTerms(query.terms, { phrases: true, negation: true, or: true })
  if (verbatim) {
    // Boolean structure beyond same-field positive chains: hand the raw text
    // to the engines unchanged and skip local constraint filtering entirely
    // (canonical date bounds stay active — they are unambiguous conjunctions).
    query.verbatim = true
    query.sites = []
    query.excludedSites = []
    query.inUrl = []
    query.excludedInUrl = []
    query.inTitle = []
    query.excludedInTitle = []
    query.inText = []
    query.excludedInText = []
    query.filetypes = []
    query.excludedFiletypes = []
    query.orGroups = []
    query.hasConstraints = query.before !== undefined || query.after !== undefined
    return query
  }
  query.hasConstraints = query.sites.length > 0 || query.excludedSites.length > 0
    || query.inUrl.length > 0 || query.excludedInUrl.length > 0
    || query.inTitle.length > 0 || query.excludedInTitle.length > 0
    || query.inText.length > 0 || query.excludedInText.length > 0
    || query.filetypes.length > 0 || query.excludedFiletypes.length > 0
    || query.orGroups.length > 0
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

/** Canonical directive keyword per constraint field (stable rendering order). */
const CONSTRAINT_DIRECTIVES: Record<ConstraintField, string> = {
  site: 'site',
  inUrl: 'inurl',
  inTitle: 'intitle',
  inText: 'intext',
  filetype: 'filetype',
}
/** Format one parsed query for an engine's supported operator syntax. */
export function formatQuery(query: StructuredQuery, syntax: QuerySyntax = {}): string {
  if (query.verbatim) return query.raw.trim()
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
  // Explicit same-field OR chains render as their canonical operator form.
  // OR binds looser than the implicit AND, so a chain is parenthesized unless
  // it stands alone. Engines without OR support receive the chain text
  // verbatim — preserving the user's Boolean meaning beats silently AND-ing
  // the values together.
  const dateCount = syntax.dateRange && (query.after !== undefined || query.before !== undefined) ? 1 : 0
  const standaloneGroup = parts.length === 0 && dateCount === 0 && query.orGroups.length === 1
  for (const group of query.orGroups) {
    const rendered = group.values.map(value => `${CONSTRAINT_DIRECTIVES[group.field]}:${quoteValue(value)}`).join(' OR ')
    parts.push(standaloneGroup ? rendered : `(${rendered})`)
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
  if (parsed.verbatim) return query
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
  /** Negative dimensions (explicit exclusions) are never relaxed. */
  negated: boolean
  predicate: (source: WebSearchSource) => boolean
}

function constraintDimensions(query: StructuredQuery): ConstraintDimension[] {
  const dimensions: ConstraintDimension[] = []
  const lower = (value: string | undefined): string => value?.toLowerCase() ?? ''
  if (query.sites.length > 0) dimensions.push({
    label: query.sites.map(site => `site:${site}`).join(' OR '),
    negated: false,
    predicate: source => query.sites.some(site => matchesSite(source.url, site)),
  })
  if (query.excludedSites.length > 0) dimensions.push({
    label: query.excludedSites.map(site => `-site:${site}`).join(' '),
    negated: true,
    predicate: source => !query.excludedSites.some(site => matchesSite(source.url, site)),
  })
  if (query.inUrl.length > 0) dimensions.push({
    label: query.inUrl.map(value => `inurl:${value}`).join(' '),
    negated: false,
    predicate: source => query.inUrl.every(value => lower(source.url).includes(value.toLowerCase())),
  })
  if (query.excludedInUrl.length > 0) dimensions.push({
    label: query.excludedInUrl.map(value => `-inurl:${value}`).join(' '),
    negated: true,
    predicate: source => !query.excludedInUrl.some(value => lower(source.url).includes(value.toLowerCase())),
  })
  if (query.inTitle.length > 0) dimensions.push({
    label: query.inTitle.map(value => `intitle:${value}`).join(' '),
    negated: false,
    predicate: source => query.inTitle.every(value => lower(source.title).includes(value.toLowerCase())),
  })
  if (query.excludedInTitle.length > 0) dimensions.push({
    label: query.excludedInTitle.map(value => `-intitle:${value}`).join(' '),
    negated: true,
    predicate: source => !query.excludedInTitle.some(value => lower(source.title).includes(value.toLowerCase())),
  })
  if (query.filetypes.length > 0) dimensions.push({
    label: query.filetypes.map(type => `filetype:${type}`).join(' OR '),
    negated: false,
    predicate: source => query.filetypes.some(type => matchesFiletype(source.url, type)),
  })
  if (query.excludedFiletypes.length > 0) dimensions.push({
    label: query.excludedFiletypes.map(type => `-filetype:${type}`).join(' '),
    negated: true,
    predicate: source => !query.excludedFiletypes.some(type => matchesFiletype(source.url, type)),
  })
  // Explicit same-field OR chains (positive directives only). `inText` groups
  // stay engine-side: a merged source carries no observable body text.
  for (const group of query.orGroups) {
    if (group.field === 'inText') continue
    const directive = CONSTRAINT_DIRECTIVES[group.field]
    const values = group.values
    dimensions.push({
      label: values.map(value => `${directive}:${value}`).join(' OR '),
      negated: false,
      predicate: (source) => {
        if (group.field === 'site') return values.some(site => matchesSite(source.url, site))
        if (group.field === 'filetype') return values.some(type => matchesFiletype(source.url, type))
        const haystack = group.field === 'inUrl' ? lower(source.url) : lower(source.title)
        return values.some(value => haystack.includes(value.toLowerCase()))
      },
    })
  }
  if (query.after !== undefined || query.before !== undefined) {
    const after = query.after === undefined ? undefined : Date.parse(query.after)
    const before = query.before === undefined ? undefined : Date.parse(query.before)
    dimensions.push({
      label: [query.after === undefined ? '' : `after:${query.after}`, query.before === undefined ? '' : `before:${query.before}`]
        .filter(Boolean).join(' '),
      negated: false,
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

/** Options for {@link applyQueryConstraints}. */
export interface ConstraintFilterOptions {
  /**
   * Allow a positive filter that would erase every remaining source to relax
   * (reported in `dropped`) instead of returning an empty result. Explicit
   * user intent is otherwise honored strictly: relaxation is opt-in.
   * Negative filters (exclusions) are never relaxed either way.
   */
  readonly relaxPositive?: boolean
}

/**
 * Apply each observable constraint independently. Negative filters are always
 * strict — an exclusion that matches every source is an empty answer, not a
 * reason to ignore the user, and is reported via `emptiedBy`. Positive filters
 * relax (with a report) only when `options.relaxPositive` is enabled; by
 * default an over-constrained positive filter empties the result honestly.
 * Verbatim (Boolean-structured) queries skip local filtering entirely.
 */
export function applyQueryConstraints(
  sources: readonly WebSearchSource[],
  query: StructuredQuery,
  options: ConstraintFilterOptions = {},
): ConstraintFilterResult {
  let current = [...sources]
  const dropped: string[] = []
  if (current.length === 0) return { sources: current, dropped }
  if (query.verbatim) return { sources: current, dropped }
  const dimensions = constraintDimensions(query)
  for (const dimension of dimensions) {
    if (!dimension.negated) continue
    const kept = current.filter(dimension.predicate)
    if (kept.length === 0) return { sources: [], dropped, emptiedBy: dimension.label }
    current = kept
  }
  for (const dimension of dimensions) {
    if (dimension.negated) continue
    const kept = current.filter(dimension.predicate)
    if (kept.length > 0) current = kept
    else if (options.relaxPositive === true) dropped.push(dimension.label)
    else return { sources: [], dropped, emptiedBy: dimension.label }
  }
  return { sources: current, dropped }
}
