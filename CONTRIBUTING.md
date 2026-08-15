# Contributing

## Prerequisites

- Node.js 22.19 or newer
- npm

Install exactly from the lockfile:

```bash
npm ci
```

## Validation

Every behavioral change needs a direct regression test covering normal, edge, and failure
behavior. Run the same checks as CI:

```bash
npm run check
npm test
npm run build
npm run lint:package
npm pack --dry-run
npm audit --omit=dev
```

Parser tests must use fixture HTML, never the live web — a challenged or redesigned engine
page must not make the suite red. Live scraping is covered by the opt-in real test only:

```bash
DSH_WEB_SEARCH_REAL_E2E=1 npm run test:real
```

The real test needs outbound network access, tolerates engine bot challenges (including the
403 response Ecosia returns for headless clients), and treats a changed organic-result set as
expected — record the observed engine behavior (per-engine result counts, challenge states)
in the commit message when you validate a parser change against live sites.

## Public release

The package is published as a prebuilt public npm artifact. Do not publish TypeScript sources
or ask users to approve a Git dependency’s build script.

Run the non-publishing release gate from a clean worktree:

```bash
npm run release:check
```

The release owner must be a member of the npm `deepseek-ai` organization, enable 2FA, and log
in locally. Never send an npm password, OTP, or token through chat or commit it to the
repository. To run the same gate and publish the exact `package.json` version:

```bash
npm login
npm run release:publish
```

The script refuses a dirty worktree, an unexpected package name, a missing npm login, and a
version that already exists. It runs the complete validation suite, shows the tarball
contents, prompts for confirmation, and publishes with `--access public` to the public npm
registry.

After publication, verify the registry artifact rather than the local checkout:

```bash
npm view @hy-sde-org/dsh-web-search-public version
dsh plugin --profile web add @hy-sde-org/dsh-web-search-public
dsh web --dump-config
```

## Design constraints

- Keep the chain credential-free. Never add an API-key path, even as a fallback.
- Keep engines strictly sequential and fail-forward: zero results, a timed-out engine, and a
  failed request all advance to the next engine; only an all-engine failure may throw.
- Keep every engine secret-free and header-lean: the browser-shaped `userAgent` constant and
  an `accept` header, nothing more.
- Keep parsers tolerant: a challenged or redesigned page must parse to zero organic results,
  never throw into the chain.
- Keep tests fixture-based; the live suite is opt-in (`DSH_WEB_SEARCH_REAL_E2E=1`).
- Preserve the web seam contracts: providers return fully-formed `WebSearchSource[]` and the
  consumer sets `truncated`; never mark results truncated yourself.
- Preserve `redirect: "error"` on every engine fetch.
- Preserve the oh-my-pi attribution and its MIT notice ([THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)) whenever engine code is changed or extended.

Changes to these constraints require updating this file and [docs/operations.md](docs/operations.md).
