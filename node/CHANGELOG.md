# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions stay on 1.0.x: every release bumps the
last number, and releases only add to the public API. release-please writes new entries from Conventional
Commits.

## [1.0.1](https://github.com/StowCards/stow-examples/compare/node-v1.0.0...node-v1.0.1) (2026-10-27)


### Bug Fixes

* move the SDK to StowCards/stow-examples and point npm at node/ ([#1](https://github.com/StowCards/stow-examples/issues/1)) ([f085c09](https://github.com/StowCards/stow-examples/commit/f085c09f732c5e3c4d42d8317a8adc5109cfa13d))

## 1.0.0 (2026-10-13)

First public release, covering version 1.0.14 of the Stow Cards API.

### Features

- `StowClient` with API key authentication, configured by options or the `STOW_API_KEY`, `STOW_BASE_URL`
  and `STOW_LOG` environment variables.
- Programs: `list`, `get`.
- Members: `enroll`, `list` (search plus email, phone, program, status, pass stage, tag and wallet
  filters), `findByCode`, `findByEmail`, `findByPhone`, `get`, `listTags`, `addTags`, `removeTags`,
  `import`, `adjustPoints`, `redeemReward`, `updateStatus`, `pushPass` (with an optional lock-screen
  message), `listEvents`, `listTransactions`.
- Background CSV imports for large files: `members.startImport`, `getImport`, `listImportRows` and
  `waitForImport` (polling with a timeout and `AbortSignal` support), with the `ImportJob` and
  `ImportJobRow` types. `members.import` runs inside one request, so it suits small files.
- Webhook subscriptions: `list`, `create`, `get`, `update`, `delete`, `rotateSecret`, `test`,
  `listDeliveryLogs`, `replayDelivery`.
- `constructWebhookEvent` and `verifyWebhookSignature` with constant-time comparison, replay tolerance and
  multiple secrets for rotation; `isWebhookTestEvent` to recognise test deliveries;
  `generateWebhookTestHeaders` for tests.
- `parseMemberBarcode` to turn a scanned pass barcode into a Member ID.
- Automatic retries with exponential backoff and full jitter, honouring `Retry-After`.
- Automatic idempotency keys on balance and status changes, reused across retries.
- Per-call timeouts, `AbortSignal` cancellation, auto-pagination and `.withResponse()` metadata.
- Typed error hierarchy carrying the status, code, details and request id.
- ESM and CommonJS builds with type declarations; no runtime dependencies.
