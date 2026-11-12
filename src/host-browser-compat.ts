/**
 * Compile-time compatibility assertion between this plugin's hand-written
 * browser seam (`PageScraper`) and the host browser service's
 * `fetchPageHtml` API (`@deepseek-ai/dsh-browser`).
 *
 * The plugin must stay installable WITHOUT a browser, so the host package is
 * never imported at runtime — this file mirrors the exact signature of
 * `BrowserService.fetchPageHtml` (harness checkout:
 * packages/browser/browser/src/service.ts, `@deepseek-ai/dsh-browser@0.2.2-rc.1`)
 * and asserts structural compatibility. If the host signature drifts,
 * `npm run check` fails here first — update the mirror (and, if needed,
 * `PageScraper`) in the same change. Bump this mirror whenever the plugin's
 * peer range for `@deepseek-ai/dsh-web` (and its bundled `dsh-browser`) moves.
 */

import type { LoadedHtmlPage, PageScraper, PageScraperOptions } from './engines/browser-page.ts'

/** Exact mirror of the host `BrowserService.fetchPageHtml` options shape. */
export interface HostFetchPageHtmlOptions {
  homeUrl?: string
  ready?: { selector: string; timeoutMs: number }
  timeoutMs?: number
  signal?: AbortSignal
  /** Mojeek-style ALTCHA interstitial: click its checkbox, wait for the PoW redirect to show results. */
  altcha?: { resultsSelector: string; waitMs: number }
}

/** Exact mirror of the host `BrowserService.fetchPageHtml` return shape. */
export interface HostFetchPageHtmlResult {
  html: string
  status: number
  url: string
}

/**
 * Exact mirror of the host `BrowserService.fetchPageHtml` callable shape,
 * detached from `this` (the host exposes it as a method).
 */
export type HostFetchPageHtml = (
  url: string,
  options?: HostFetchPageHtmlOptions,
) => Promise<HostFetchPageHtmlResult>

/** Fails to compile unless `T` is literally `true`. */
type Assert<T extends true> = T

// The options mirror and the seam's options stay mutually assignable: a host
// option rename/type change or a new REQUIRED host option breaks at least one
// direction.
type OptionsHostToSeam = HostFetchPageHtmlOptions extends PageScraperOptions ? true : false
type OptionsSeamToHost = PageScraperOptions extends HostFetchPageHtmlOptions ? true : false

// The host callable satisfies the seam: a real `BrowserService.fetchPageHtml`
// method can be handed to the plugin wherever a `PageScraper` is expected.
type HostSatisfiesSeam = HostFetchPageHtml extends PageScraper ? true : false

// The host result is accepted as a seam `LoadedHtmlPage` (the seam's extra
// fields — `contentType`, `cfMitigated` — are optional).
type ResultSatisfiesSeam = HostFetchPageHtmlResult extends LoadedHtmlPage ? true : false

export type HostBrowserOptionsCompatible = Assert<OptionsHostToSeam & OptionsSeamToHost>
export type HostBrowserCallableCompatible = Assert<HostSatisfiesSeam>
export type HostBrowserResultCompatible = Assert<ResultSatisfiesSeam>

// The reverse callable direction (seam → host) is intentionally NOT asserted:
// the seam requires its options argument while the host may be called without
// them, so the seam is a NARROWER contract than the host API. Plugin
// correctness depends exactly on the host → seam directions above.

/** Runtime marker so the type-only assertions cannot be tree-shaken away. */
export const HOST_BROWSER_COMPAT_ASSERTED = 'asserted-at-compile-time' as const
