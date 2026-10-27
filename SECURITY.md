# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through
[GitHub private vulnerability reporting](https://github.com/StowCards/stow-examples/security/advisories/new).
If you cannot use GitHub, email **hello@stow.cards** with "Security" in the subject.

Please include:

- the affected part (the Node.js SDK and its version, or the language example) and a description of the
  issue and its impact;
- steps or code to reproduce it;
- any suggested fix.

Never include a real API key, webhook secret or customer data in a report.

## What to expect

We aim to acknowledge your report promptly, keep you informed while we assess it, and release a fix for
a confirmed issue as soon as we can, prioritised by severity.

We follow coordinated disclosure: we agree a disclosure date with you, publish a GitHub security
advisory (with a CVE where appropriate) when the fix ships, and credit you unless you prefer otherwise.

This policy covers the Node.js SDK and the examples in this repository. Report issues in the Stow Cards
service itself the same way; they will be routed to the right team.

## Supported versions

| Part                           | Supported                |
| ------------------------------ | ------------------------ |
| Node.js SDK (`@stowcards/sdk`) | 1.0.x                    |
| Language examples              | The latest `main` branch |

Security fixes to the SDK ship in the next 1.0.x release. Releases only add to the public API, so
upgrading to the latest 1.0.x is always safe. The examples are not released; fixes land on `main`.

## Using the SDK and the examples securely

- Keep API keys on your server, in a secrets manager. Never commit them or ship them to a browser or app.
- Give each integration its own key with the least-privileged role, and set an expiry where you can.
- Verify every webhook delivery with the SDK's `constructWebhookEvent` over the raw request body, and
  dedupe on `eventId`.
- Keep the SDK up to date; Dependabot or Renovate can do this for you.
- The SDK and the examples refuse plain HTTP except to a local gateway, never follow redirects and never
  print the key. Keep those properties if you adapt them.

## Supply chain

SDK releases are built and published from GitHub Actions through npm trusted publishing, with a
provenance attestation you can check with `npm audit signatures`. Each SDK release on GitHub carries a
CycloneDX SBOM. The SDK has no runtime dependencies.
