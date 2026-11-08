# Security policy

## Reporting a vulnerability

Please use GitHub’s private security-advisory flow for this repository. Do not open a public
issue containing credentials, unpublished exploit details, or customer data.

- **Email**: hui.sde.us@gmail.com (private contact, preferred if the advisory flow is unavailable)

Include the affected version, a minimal reproduction, impact, and any suggested mitigation.
Rotate any credential that may have been exposed during testing.

## Deployment assumptions

- The plugin never reads API keys or account tokens. Queries are sent verbatim to all
  configured public search engines; treat them as public text.
- Requests carry a browser-shaped User-Agent. Google requests include a fixed consent cookie,
  and browser escalation may send engine-issued cookies or storage retained by the mounted
  browser service's scraper context.
- The bundle mounts no fetch provider and changes no `tool-web` setting.
- Plain-fetch response bodies are capped at 2 MiB before parsing. Browser escalation rejects
  rendered HTML above 2 Mi characters.
- Plain-fetch legs reject redirects before following their targets. Browser escalation is a
  normal browser navigation and may follow redirects or load subresources.
- Parsed snippets and titles are untrusted public text rendered as citations, never executed.

See [docs/operations.md](docs/operations.md) for runtime expectations and troubleshooting.

