# Stow Cards API examples and Node.js SDK

[![Examples](https://github.com/StowCards/stow-examples/actions/workflows/ci.yml/badge.svg)](https://github.com/StowCards/stow-examples/actions/workflows/ci.yml)
[![Node.js SDK](https://github.com/StowCards/stow-examples/actions/workflows/node-sdk.yml/badge.svg)](https://github.com/StowCards/stow-examples/actions/workflows/node-sdk.yml)
[![npm](https://img.shields.io/npm/v/@stowcards/sdk.svg)](https://www.npmjs.com/package/@stowcards/sdk)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

The official Node.js SDK for the [Stow Cards API](https://stow.cards/developers/), and runnable examples
in Python, PHP, Ruby, Java, .NET and Go.

| Folder | What it is |
|---|---|
| [`node/`](node/) | The official Node.js SDK, published on npm as [`@stowcards/sdk`](https://www.npmjs.com/package/@stowcards/sdk), with its own [examples](node/examples/) |
| [`python/`](python/), [`php/`](php/), [`ruby/`](ruby/), [`java/`](java/), [`dotnet/`](dotnet/), [`go/`](go/) | Runnable examples, one small client per language |

## Node.js SDK

```bash
npm install @stowcards/sdk
```

The SDK covers programs, members, points, rewards, wallet pushes, imports and webhooks, with types,
retries, idempotency keys and webhook signature checks built in. [`node/README.md`](node/README.md) is the
full guide; [`node/examples/`](node/examples/) has a loyalty loop, a till scanner and a webhook receiver.
Releases are cut from this repository by release-please, tagged `node-vX.Y.Z` and published to npm with
a provenance attestation (see [`node/RELEASING.md`](node/RELEASING.md)).

## Language examples

Each language example performs the **same end-to-end flow**:

```
list programs → enroll a member → award 10 points (idempotent) → read the member back
```

They all read two environment variables:

```bash
export STOW_API_KEY="stow_your_key_here"                # required: an API key bound to your merchant
export STOW_BASE_URL="https://api.stow.cards/api/v1"   # optional: this is the default
```

| Language | Folder | Requirements | Run |
|---|---|---|---|
| Python | [`python/`](python/) | Python 3.9+, standard library only | `python3 python/demo.py` |
| PHP | [`php/`](php/) | PHP 8.2+ with `ext-curl` and `ext-json` | `php php/demo.php` |
| Ruby | [`ruby/`](ruby/) | Ruby 3.1+, standard library only | `ruby ruby/demo.rb` |
| Java | [`java/`](java/) | Java 17+ and Maven (Jackson is the only dependency) | `cd java && mvn -q compile exec:java` |
| .NET | [`dotnet/`](dotnet/) | .NET 10 SDK, no NuGet packages | `cd dotnet && dotnet run` |
| Go | [`go/`](go/) | Go 1.22+, standard library only | `cd go && go run .` |

For Node.js, use the SDK above: [`node/examples/quickstart.mjs`](node/examples/quickstart.mjs) runs the
same flow with it (run `npm ci && npm run build` in `node/` first).

### Before you run them

- You need a Stow Cards account with at least one **active** program, published in the console's Pass
  Designer.
- Create an API key in the console under **Administration → API Keys**. Its role needs
  `merchants.programs:view`, `merchants.members:create`, `merchants.members:edit` (the points change) and
  `merchants.members:view` (the read-back).
- The demo enrolls `dev+<timestamp>@example.com`, so repeated runs create fresh members instead of hitting
  the `(programId, email)` dedupe. Every enrolment issues real wallet passes when the merchant has wallet
  credentials, so point the demo at a test merchant.

### What every client does

Each language folder ships a small reusable client, the runnable demo and its own `README`. The clients
follow the same rules as the official SDK:

- the key goes in the `X-API-Key` header, over HTTPS; plain HTTP is accepted only for a local gateway
  (`localhost`, `127.0.0.1`, `[::1]`, a `.localhost` name or `host.docker.internal`);
- the key is never printed, and a key containing spaces, line breaks or non-ASCII characters is refused;
- the points change carries an `Idempotency-Key` made once for the gesture and reused on every retry, so
  a retry can never award twice;
- network errors, timeouts, 408, 429, 500, 502, 503 and 504 are retried at most twice with backoff and
  jitter, honouring `Retry-After` up to 60 seconds, but only for reads, enrolment (which dedupes on program
  and email) and the keyed points change; a `409 IDEMPOTENCY_KEY_IN_USE` is waited out only on a retry of
  the client's own keyed request;
- each attempt times out after about 30 seconds, response body included, and redirects are never followed;
- errors carry the HTTP status, the API's `error.code` and the request id from `X-Correlation-Id`, which is
  what support asks for. Configuration errors exit with code 2, API and connection errors with code 1.

For the full API surface, see the [API reference](https://stow.cards/developers/api-reference.html).

## Checks

The SDK runs its own checks (format, lint, types, tests with coverage, build, API report, package):

```bash
cd node && npm ci && npm run ci
```

For the language examples, [`tests/check.sh`](tests/check.sh) builds one example and runs its demo against
[`tests/mock_gateway.py`](tests/mock_gateway.py), a local stand-in for the API that never touches real
data. It checks the full flow, a retried points change that keeps its `Idempotency-Key`, the
`409 IDEMPOTENCY_KEY_IN_USE` rule, an invalid key, and the configuration errors:

```bash
tests/check.sh python    # or php, ruby, java, dotnet, go
```

CI runs the SDK's checks on Node.js 22, 24 and 26, and `tests/check.sh` for every language on its
oldest supported version and a current one.

## Contributing

Issues and pull requests are welcome. For the SDK, read [`node/CONTRIBUTING.md`](node/CONTRIBUTING.md)
first. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
