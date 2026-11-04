# Security policy

## Reporting a vulnerability

Please use GitHub’s private security-advisory flow for this repository. Do not open a public
issue containing credentials, unpublished exploit details, or customer data.

- **Email**: hui.sde.us@gmail.com (private contact, preferred if the advisory flow is unavailable)

Include the affected version, a minimal reproduction, impact, and any suggested mitigation.
Rotate any credential that may have been exposed during testing.

## Deployment assumptions

- The plugin never reads, stores, or transmits credentials: searches are anonymous requests
  to public search engines. There is nothing to leak.
- Queries are sent verbatim to the configured public engines, so treat a query as public
  text. Do not search for secrets, tokens, or PII.
- No fetch provider is mounted and no `tool-web` setting is changed, so the model's ability
  to fetch arbitrary URLs is decided by your `tool-web` row (the shipped harness base
  enables fetch), not by this plugin. The provider's own network access is limited to the
  engines' documented search endpoints (GET/POST).
- Redirects are rejected per transport: every plain-fetch leg uses `redirect: "error"`, so a
  hostile response cannot redirect that leg onto an external location; when a challenge
  triggers browser escalation, the navigation is a real browser page load and may follow
  redirects like any browser visit.
- Parsed snippets and titles are rendered to the model as citations; they are public
  third-party text and are neither trusted nor executed.

See [docs/operations.md](docs/operations.md) for runtime expectations and troubleshooting.

