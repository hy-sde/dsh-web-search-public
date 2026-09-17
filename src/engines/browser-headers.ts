/**
 * Coherent desktop navigation headers for the credential-free engines' plain
 * fetch — a port of oh-my-pi's `browser-headers.ts` minus the randomizer.
 * The header set is derived from the caller's Chrome-shaped `User-Agent`, so
 * client hints (Sec-Ch-Ua*) and the UA string stay internally consistent (a
 * mismatched pair is itself a bot signal). This only makes the cheap fetch
 * path look like a real browser; the escalation to an actual stealth browser
 * lives in `browser-page.ts`.
 * @module @hy-sde-org/dsh-web-search-public/engines/browser-headers
 */

/**
 * Build one internally consistent desktop navigation header set for a
 * Chrome-shaped `User-Agent`. Non-Chrome agents still get the Sec-Fetch*
 * navigation shape, just without client hints.
 */
export function buildBrowserNavigationHeaders(userAgent: string): Record<string, string> {
  const chrome = /Chrome\/(\d+)(?:\.(\d+)\.(\d+))?/.exec(userAgent)
  const secChUa = chrome === null
    ? undefined
    : `"Google Chrome";v="${chrome[1]}", "Chromium";v="${chrome[1]}", ";Not A Brand";v="99"`

  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'max-age=0',
    Priority: 'u=0, i',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': userAgent,
  }
  if (secChUa !== undefined) {
    headers['Sec-Ch-Ua'] = secChUa
    headers['Sec-Ch-Ua-Mobile'] = '?0'
    headers['Sec-Ch-Ua-Platform'] = '"macOS"'
  }
  return headers
}
