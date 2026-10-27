## What and why

<!-- What does this change, and why? Link the issue it closes (Fixes #123). -->

## Checklist

- [ ] The title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- [ ] Commits are signed off (`git commit -s`) under the [Developer Certificate of Origin](https://developercertificate.org/).

For a change to the Node.js SDK in `node/`:

- [ ] Nothing existing breaks: the SDK stays on 1.0.x and only adds to its public API.
- [ ] Tests cover the change, and `npm run ci` passes locally (in `node/`).
- [ ] Public API changes are reflected in `node/review/stowcards-sdk.api.md` (`npm run api:update`) and the README.

For a change to a language example:

- [ ] `tests/check.sh <language>` passes locally, and the example's README matches its behaviour.
