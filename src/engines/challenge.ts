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
 * @module @hy-sde-org/dsh-web-search-public/engines/challenge
 */

const CHALLENGE_SIGNATURES: readonly RegExp[] = [
  /px-captcha/i, // PerimeterX widget (Startpage wall)
  /perimeterx/i,
  /press\s*(?:&amp;|&)\s*hold/i, // PerimeterX "Press & Hold" button (raw or entity-encoded)
  /altcha/i, // Mojeek proof-of-work wall
  /captcha-wrap/i,
  /unfortunately, bots use duckduckgo/i, // DuckDuckGo anomaly banner
  /cdn-cgi\/challenge-platform/i, // Cloudflare interstitial asset
  /cf-chl/i, // Cloudflare challenge bootstrap
  /cf-turnstile/i, // Cloudflare Turnstile widget
  /g-recaptcha/i,
  /unusual traffic from your computer/i, // Google sorry page
  /verify\s+that\s+you['’]?re\s+(a\s+)?(human|robot)/i,
  /are you a (robot|human)\?/i,
]

/** `true` when the (empty-parsed) page carries a known bot-wall marker. */
export function looksLikeChallengePage(html: string): boolean {
  return CHALLENGE_SIGNATURES.some((pattern) => pattern.test(html))
}
