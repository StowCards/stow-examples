# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through
[GitHub private vulnerability reporting](https://github.com/StowCards/stow-examples/security/advisories/new).
If you cannot use GitHub, email **hello@stow.cards** with "Security" in the subject.

Include the affected example, a description of the issue and its impact, and steps to reproduce it.
Never include a real API key, webhook secret or customer data in a report.

We aim to acknowledge your report promptly, keep you informed while we assess it, and release a fix for
a confirmed issue as soon as we can, prioritised by severity. Problems in the Stow Cards service itself
can be reported the same way; they will be routed to the right team.

## Using the examples securely

- Keep API keys on your server, in a secrets manager. Never commit them or ship them to a browser or app.
- Give each integration its own key with the least-privileged role it needs.
- The examples refuse plain HTTP except to a local gateway, never follow redirects and never print the key.
  Keep those properties if you adapt them.
