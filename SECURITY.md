# Security policy

## Reporting a vulnerability

Please use GitHub’s private security-advisory flow for this repository. Do not open a public
issue containing credentials, unpublished exploit details, or customer data.

Include the affected version, a minimal reproduction, impact, and any suggested mitigation.
Rotate any credential that may have been exposed during testing.

## Deployment assumptions

- The plugin never reads, stores, or transmits credentials: searches are anonymous requests
  to public search engines. There is nothing to leak.
- Queries are sent verbatim to the configured public engines, so treat a query as public
  text. Do not search for secrets, tokens, or PII.
- No fetch provider is mounted (`tool-web` `fetch: false`), so the model cannot be pointed at
  arbitrary URLs; SSRF surfaces stay closed.
- All engine fetches use `redirect: "error"`, so a hostile response cannot redirect the
  provider onto an external location.
- Parsed snippets and titles are rendered to the model as citations; they are public
  third-party text and are neither trusted nor executed.

See [docs/operations.md](docs/operations.md) for runtime expectations and troubleshooting.

