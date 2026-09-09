/**
 * Shared anonymous HTML fetch used by the credential-free engines.
 * @module @hy-sde-org/dsh-web-search-public/engines/http
 */

export interface FetchHtmlOptions {
  url: string
  method?: 'GET' | 'POST'
  /** Form-encoded request body (POST only). */
  body?: string
  /** Extra headers merged over the base set. */
  headers?: Readonly<Record<string, string>>
  userAgent: string
  signal?: AbortSignal | undefined
}

/**
 * Fetch and return the response body text. Redirects are rejected before any
 * `Location` target is contacted (the web-package AGENTS.md rule); a non-2xx
 * response fails. Errors carry a short human-readable message for the chain's
 * failure aggregate.
 */
export async function fetchHtml(options: FetchHtmlOptions): Promise<string> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.8',
    ...options.headers,
  }
  if (options.method === 'POST' && options.body !== undefined && !('content-type' in headers)) {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
  }
  const init: RequestInit = { method: options.method ?? 'GET', headers, redirect: 'error' }
  if (options.body !== undefined) init.body = options.body
  if (options.signal !== undefined) init.signal = options.signal
  const response = await fetch(options.url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}
