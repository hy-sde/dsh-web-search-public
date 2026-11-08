/**
 * Shared anonymous HTML fetch used by the credential-free engines.
 * @module @hy-sde-org/dsh-web-search-public/engines/http
 */

import { EngineSearchFailure } from '../types.ts'

/** Maximum decoded response bytes accepted from one plain-fetch engine request. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024

/** Read one response body without buffering more than {@link MAX_HTML_BYTES}. */
export async function readHtmlResponse(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > MAX_HTML_BYTES) {
    await response.body?.cancel()
    throw new EngineSearchFailure(
      'invalidResponse',
      `response exceeded the ${MAX_HTML_BYTES}-byte HTML limit`,
    )
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_HTML_BYTES) {
        await reader.cancel()
        throw new EngineSearchFailure(
          'invalidResponse',
          `response exceeded the ${MAX_HTML_BYTES}-byte HTML limit`,
        )
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

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
 * response fails with an {@link EngineSearchFailure} carrying the status (4xx
 * hard-blocks that engine, 5xx is retryable). Redirect rejections and network
 * failures propagate as `TypeError`s — the provider's legacy signatures
 * classify them as retryable transport problems.
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
  if (!response.ok) throw new EngineSearchFailure('http', `HTTP ${response.status}`, response.status)
  return await readHtmlResponse(response)
}
