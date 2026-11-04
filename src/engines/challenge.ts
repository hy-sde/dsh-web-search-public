/**
 * Conservative bot-challenge detection for wall pages that slip past the
 * engines' own block classifiers (Google blockReason, Ecosia isBlockedPage,
 * Mojeek isRobotPage) — e.g. Startpage's PerimeterX wall or DuckDuckGo's
 * anomaly form, which arrive as HTTP 200 and would otherwise parse to a
 * "successful empty search".
 *
 * Callers MUST only consult this on a page whose parse produced zero results.
 * The signatures below then decide between "legitimately empty" and "walled":
 * a genuine results page ABOUT captchas carries results, so it can never be
 * misclassified, and an empty page is only called a challenge when a
 * structural/branded wall marker is present.
 *
 * The signatures match STRUCTURAL evidence — challenge widget elements, their
 * `id`/`class` attributes, and challenge infrastructure assets — never bare
 * terms: search pages echo the query inside form controls and the title, so a
 * query containing e.g. "perimeterx" must not trip the matcher. Those echo
 * surfaces are stripped before matching as a second defense.
 * @module @hy-sde-org/dsh-web-search-public/engines/challenge
 */

const CHALLENGE_SIGNATURES: readonly RegExp[] = [
  // Challenge widgets announce themselves in `id`/`class` attributes:
  // PerimeterX (Startpage), Mojeek's captcha wrapper, reCAPTCHA, Cloudflare.
  /<[^>]*\b(?:id|class)\s*=\s*["']?[^"'>]*\b(?:px-captcha|captcha-wrap|g-recaptcha|cf-chl|cf-turnstile)\b/i,
  // Challenge infrastructure loaded as scripts (PerimeterX, Cloudflare).
  /<script[^>]*\bsrc\s*=\s*["'][^"']*(?:perimeterx|\/cdn-cgi\/challenge-platform\/)/i,
  // The ALTCHA proof-of-work custom element (Mojeek wall).
  /<altcha[\s/>-]/i,
  // Wall banners are long, specific sentences — a query echoing one verbatim
  // in body text is implausible, and these walls carry no other marker.
  /unfortunately, bots use duckduckgo/i, // DuckDuckGo anomaly page
  /unusual traffic from your computer/i, // Google sorry page
]

/**
 * Remove the surfaces where engines echo the query text: form controls (the
 * echo sits INSIDE the `<input ...>` tag, so tag-anchored patterns cannot
 * exclude it — the whole tag must go), `<textarea>` bodies, and `<title>`.
 */
function stripQueryEchoSurfaces(html: string): string {
  return html
    .replace(/<input\b[^>]*>/gi, '')
    .replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
}

/** `true` when the (empty-parsed) page carries a known bot-wall marker. */
export function looksLikeChallengePage(html: string): boolean {
  const stripped = stripQueryEchoSurfaces(html)
  return CHALLENGE_SIGNATURES.some((pattern) => pattern.test(stripped))
}
