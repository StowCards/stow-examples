# Contributing

Thank you for helping improve the Stow Cards Node.js SDK. It lives in the `node/` folder of
[StowCards/stow-examples](https://github.com/StowCards/stow-examples), beside the API examples in other
languages. This guide covers how to propose a change to the SDK and what a pull request needs before it
can be merged.

## Before you start

- **Security issues:** never open a public issue. Follow [SECURITY.md](../SECURITY.md).
- **Bugs and features:** search the [issues](https://github.com/StowCards/stow-examples/issues) first,
  then open one with the Node.js SDK template. For anything beyond a small fix, agree the approach in an issue before
  writing code.
- **Questions about the API or your account** belong with [Stow Cards support](SUPPORT.md), not here.

Everyone taking part follows the [Code of Conduct](../CODE_OF_CONDUCT.md).

## Development setup

You need Node.js 22 or later (24 is recommended; see `.nvmrc`) and npm.

```bash
git clone https://github.com/StowCards/stow-examples.git
cd stow-examples/node
npm ci
npm run ci     # everything CI runs: format, lint, types, tests with coverage, build, API report, package checks
```

Useful scripts:

| Script                  | What it does                                                      |
| ----------------------- | ----------------------------------------------------------------- |
| `npm test`              | Run the unit tests (Vitest).                                      |
| `npm run test:watch`    | Re-run tests on change.                                           |
| `npm run test:coverage` | Run tests with coverage thresholds (95% lines, 90% branches).     |
| `npm run lint`          | ESLint with the strict type-checked typescript-eslint rules.      |
| `npm run format`        | Format with Prettier.                                             |
| `npm run typecheck`     | Type-check sources, tests and examples.                           |
| `npm run build`         | Build ESM and CommonJS output into `dist/`.                       |
| `npm run api:update`    | Regenerate the public API report after an intended API change.    |
| `npm run check:package` | Validate the packed package with publint and Are the Types Wrong. |

## Making a change

1. Fork the repository and create a branch from `main`.
2. Write the change with tests. Every behaviour needs a test, and coverage must stay above the
   thresholds. Tests use a fake `fetch`; they never call the live API.
3. Keep the public surface deliberate. If you change it, run `npm run api:update` and commit the updated
   `review/stowcards-sdk.api.md`, so reviewers see the exact API difference. Update the README too.
4. Run `npm run ci` locally.
5. Open a pull request using the template.

### Design rules

- **No runtime dependencies.** The SDK uses Node's built-in `fetch`, `crypto` and web APIs only.
- **Match the API contract.** Methods map to documented endpoints in the
  [OpenAPI specification](https://stow.cards/developers/api-reference.html) and return the response's
  `data` unchanged. Do not expose undocumented endpoints or fields.
- **Never weaken safety defaults:** HTTPS outside localhost, no redirects, no secrets in logs or errors,
  idempotency keys on balance and status changes, and retries only for requests that are safe to repeat.
- **Backwards compatibility.** Additive changes only. The SDK stays on 1.0.x, so a change that would
  break existing code (removing or renaming an export, method or option, narrowing a type, changing a
  default) is not accepted. Add the new behaviour beside the old one and deprecate the old one instead.
- Follow the existing style: Prettier formatting, the
  [Google TypeScript style](https://google.github.io/styleguide/tsguide.html) for naming, TSDoc on every
  export.

## Commit messages

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), because release-please
builds the changelog from them. Only commits that change files under `node/` count towards an SDK
release, so a change to another language's example never releases the SDK. Every release bumps the last
number only (1.0.4 to 1.0.5):

- `fix: retry on 504 for idempotent requests` (release, listed under Bug Fixes)
- `feat: add members.export()` (release, listed under Features)
- `docs: explain pagination limits` (release, listed under Documentation, so npm shows the new README)
- `test:`, `refactor:`, `ci:`, `chore:` (no release on their own)

Breaking changes (`feat!:`, or a `BREAKING CHANGE:` footer) are not accepted, and CI rejects a pull
request that declares one.

Pull requests are squash-merged, so the pull request title must follow the same format.

## Developer Certificate of Origin

Contributions are accepted under the [Apache License 2.0](LICENSE) (inbound equals outbound, section 5).
Sign off every commit to certify the [Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "fix: handle an empty error body"
```

## Releases

Maintainers release through release-please; see [RELEASING.md](RELEASING.md).
