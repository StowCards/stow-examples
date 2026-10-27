# Stow Cards Node.js SDK

[![Node.js SDK CI](https://github.com/StowCards/stow-examples/actions/workflows/node-sdk.yml/badge.svg)](https://github.com/StowCards/stow-examples/actions/workflows/node-sdk.yml)
[![npm](https://img.shields.io/npm/v/@stowcards/sdk.svg)](https://www.npmjs.com/package/@stowcards/sdk)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/StowCards/stow-examples/badge)](https://scorecard.dev/viewer/?uri=github.com/StowCards/stow-examples)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/StowCards/stow-examples/blob/main/node/LICENSE)

The official Node.js SDK for the [Stow Cards API](https://stow.cards/developers/). Enrol customers into
your loyalty programs, hand them Apple Wallet and Google Wallet passes, award points, redeem rewards and
react to changes through signed webhooks. Every balance or status change you make is pushed to the
customer's phone automatically.

- Fully typed, with ESM and CommonJS builds and no runtime dependencies.
- Automatic retries with exponential backoff, honouring `Retry-After`.
- Idempotency keys on every balance and status change, so a retry can never apply twice.
- Per-call timeouts and `AbortSignal` cancellation.
- Auto-pagination with `for await`.
- Typed errors carrying the request id for support.
- Webhook signature verification with replay protection, and several secrets accepted at once for
  rotation.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Members and wallet passes](#members-and-wallet-passes)
- [Points, rewards and status](#points-rewards-and-status)
- [Scanning passes at the till](#scanning-passes-at-the-till)
- [Large imports](#large-imports)
- [Pagination](#pagination)
- [Errors](#errors)
- [Retries, idempotency and timeouts](#retries-idempotency-and-timeouts)
- [Response metadata](#response-metadata)
- [Webhooks](#webhooks)
- [Logging](#logging)
- [API coverage](#api-coverage)
- [Security](#security)
- [Versioning and support](#versioning-and-support)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- Node.js 22 or later (any [maintained LTS line](https://nodejs.org/en/about/previous-releases)).
- A Stow Cards account with a published pass program.
- An API key (`stow_…`) from the console: **Administration → API Keys**. Give the key the
  least-privileged role your integration needs.

The SDK is for **server-side** use. Never ship your API key to a browser or a mobile app; the client
refuses to start in a browser.

## Installation

```bash
npm install @stowcards/sdk
```

## Quickstart

```bash
export STOW_API_KEY="stow_your_key"
```

```ts
import { StowClient } from '@stowcards/sdk';

const stow = new StowClient(); // reads STOW_API_KEY

// 1. Find the program to enrol into.
const program = (await stow.programs.list()).find((p) => p.status === 'active');
if (!program) throw new Error('Publish a program in the Stow Cards console first.');

// 2. Enrol a customer. Their wallet passes are issued straight away.
const member = await stow.members.enroll({
  programId: program._id,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
});
console.log(member.memberCode); // "7K2P9QX4M8", the Member ID printed on the pass
console.log(member.apple?.passUrl); // Add to Apple Wallet
console.log(member.google?.saveUrl); // Save to Google Wallet

// 3. Award points. The pass on their phone updates with your message.
await stow.members.adjustPoints(member.id, { delta: 10, changeMessage: 'Thanks for visiting!' });
```

CommonJS works too:

```js
const { StowClient } = require('@stowcards/sdk');
```

More complete programs live in [`examples/`](https://github.com/StowCards/stow-examples/tree/main/node/examples): the
[loyalty loop](https://github.com/StowCards/stow-examples/blob/main/node/examples/quickstart.mjs), a
[till scanner](https://github.com/StowCards/stow-examples/blob/main/node/examples/till-scan.mjs) and a
[webhook receiver](https://github.com/StowCards/stow-examples/blob/main/node/examples/webhook-server.mjs).

## Configuration

```ts
const stow = new StowClient({
  apiKey: process.env.STOW_API_KEY,
  timeout: 15_000,
  maxRetries: 3,
  appInfo: { name: 'acme-pos', version: '4.2.0' },
});
```

| Option                    | Default                                               | Description                                                                                       |
| ------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apiKey`                  | `STOW_API_KEY`                                        | Your `stow_…` API key.                                                                            |
| `baseUrl`                 | `STOW_BASE_URL`, then `https://api.stow.cards/api/v1` | API base URL including `/api/v1`. Must be `https` except on localhost.                            |
| `timeout`                 | `30000`                                               | Per-attempt timeout in whole milliseconds, 1 to 2147483647.                                       |
| `maxRetries`              | `2`                                                   | Retries after the first attempt. `0` disables them.                                               |
| `appInfo`                 | none                                                  | `{ name, version?, url? }`, appended to the `User-Agent`.                                         |
| `defaultHeaders`          | none                                                  | Headers added to every request, e.g. `Accept-Language` for localised errors.                      |
| `fetch`                   | global `fetch`                                        | A custom `fetch`, for proxies, instrumentation or tests.                                          |
| `logger`                  | `console`                                             | Any object with `debug`, `info`, `warn` and `error`.                                              |
| `logLevel`                | `STOW_LOG`, then `warn`                               | `debug`, `info`, `warn`, `error` or `off`.                                                        |
| `allowInsecureHttp`       | `false`                                               | Permit plain HTTP to a non-localhost host (a trusted private network only).                       |
| `dangerouslyAllowBrowser` | `false`                                               | Permit construction where `window` exists (e.g. jsdom tests). Never ship a key to a real browser. |

Every method also takes a final `options` argument that overrides `timeout`, `maxRetries` and headers
for one call and accepts an `AbortSignal`:

```ts
await stow.members.get(memberId, { timeout: 5_000, signal: AbortSignal.timeout(8_000) });
```

Create one client per API key and reuse it. It is safe to share across concurrent requests.

## Members and wallet passes

```ts
// Enrol. An email already in the program returns the existing member with `deduped: true`.
const member = await stow.members.enroll({ programId, firstName, lastName, email, initialPoints: 50 });
// A false flag means that wallet's pass could not be built: the member is saved, its link is missing.
member.passIssuance; // { apple: true, google: true } (from API 1.0.14)

// The full member: balances, wallet state, device count, redemptions.
const detail = await stow.members.get(member.id);
Number(detail.fieldValues?.points); // balance, keyed by the program's balance label (may arrive as "0")
detail.apple?.installed; // added to Apple Wallet?
detail.google?.installed; // saved to Google Wallet?

// Search by name, email, phone or the start of a Member ID, and filter.
const page = await stow.members.list({ q: 'lovelace', programId });
const vips = stow.members.list({ tag: 'vip', status: 'active', wallet: 'installed' });

// Tags. `unchanged: true` can also mean an automatic retry found its first attempt already applied.
await stow.members.addTags(member.id, ['vip']);
await stow.members.removeTags(member.id, ['vip']);
const { tags } = await stow.members.listTags();

// Import a small CSV inside one request (the gateway allows 30 s). For larger files, see Large imports.
import { readFile } from 'node:fs/promises';
const result = await stow.members.import({ programId, file: await readFile('members.csv') });
console.log(result.summary); // { totalRows, created, deduped, failed, partial }

// History.
const { items: events } = await stow.members.listEvents(member.id, { limit: 20 });
for await (const transaction of stow.members.listTransactions(member.id)) {
  console.log(transaction.action, transaction.delta, transaction.balanceAfter);
}

// Re-send the current pass to a wallet that missed an update, or send a message.
// Every push shows on the lock screen (the program's manual-push message if you send none).
await stow.members.pushPass(member.id, { changeMessage: 'Your reward is waiting at the counter' });
```

Two identifiers matter:

- **`id`** (a UUID) goes in API calls. Never show it to people.
- **`memberCode`** is the **Member ID**: printed on the pass, encoded in its barcode and read by
  scanners. It is the only member identifier that should appear in your UI.

Programs are read-only through the API and keyed by **`_id`** (members use `id`). Design and publish
them in the console's Pass Designer.

In environments without real Apple or Google credentials, passes are built in **stub** mode. Read
`member.apple.mode` and `member.google.mode`; never infer the mode from a pass URL.

## Points, rewards and status

```ts
// Relative change (clamped at 0). Stamp cards accept only +1 or -1.
await stow.members.adjustPoints(memberId, { delta: 25, changeMessage: '25 points for your order' });

// Absolute balance.
await stow.members.adjustPoints(memberId, { value: 100 });

// Redeem the reward: a full stamp card resets; a points program deducts its reward target.
await stow.members.redeemReward(memberId, { changeMessage: 'Enjoy your free coffee!' });

// Void, expire or reactivate a member. The reason goes to your audit trail, never to the customer.
const result = await stow.members.updateStatus(memberId, { status: 'voided', reason: 'Duplicate account' });
if ('unchanged' in result) {
  // The member already had this status; nothing happened.
}
```

`changeMessage` (up to 200 characters) appears on the customer's lock screen. Balance results report
`previous`, `current` and a `passUpdate` describing what was pushed to which wallet.

Only points, stamp, tiered and gift card programs carry a balance. Coupons and validate-on-scan passes
(memberships, tickets, access passes and so on) answer `adjustPoints` with a `BadRequestError`.

## Scanning passes at the till

A pass barcode encodes a template such as `MEMBER-{{memberCode}}`, while the lookup expects the bare
code. `parseMemberBarcode` reverses the template:

```ts
import { parseMemberBarcode } from '@stowcards/sdk';

const programs = await stow.programs.list(); // cache this
const templates = programs.map((program) => program.barcode?.valueTemplate);

const code = parseMemberBarcode(scannedText, { templates }); // "MEMBER-7K2P9QX4M8" -> "7K2P9QX4M8"
const member = code ? await stow.members.findByCode(code) : null;
```

Without templates it still recognises the stock `LABEL-code` shapes, URLs, JSON payloads and bare codes.
`findByCode` also matches the UUID serials carried by passes issued before Member IDs existed.

## Finding a customer by email or phone

```ts
// Exact email, any letter case.
const { items } = await stow.members.findByEmail('ada@example.com', { programId });

// Matched by digits, whatever the formatting: '+44 7700 900123' finds '447700900123'.
const byPhone = await stow.members.findByPhone('+44 7700 900123');
```

A customer can hold a pass in several programs, so both return a page of members; pass `programId` to
pick one program. A phone number needs at least 6 digits. Give it the way the customer gave it,
including the country code if they did.

## Large imports

`members.import` enrols every row inside one request, and the API gateway allows a request 30 seconds,
so it suits small files only. For anything larger (up to 1 MB and 5,000 rows) start a background
import job: the upload is validated and queued straight away, and a worker enrols the rows one at a
time.

```ts
import { readFile } from 'node:fs/promises';

const job = await stow.members.startImport({ programId, file: await readFile('members.csv') });

// Poll until it is completed, failed or cancelled (every 3 s, for up to 30 minutes by default).
const done = await stow.members.waitForImport(job.id, { timeoutMs: 15 * 60_000 });
console.log(done.status, done.createdRows, done.dedupedRows, done.failedRows, done.partialRows);

// Rows that failed validation or enrolment, with the reason.
for await (const row of stow.members.listImportRows(job.id, { status: 'failed' })) {
  console.log(row.rowNumber, row.email, row.error);
}
```

A `completed` job can still have failed rows; `failed` means rows failed and none were created. Rows
whose email is already enrolled count as `deduped`, so re-running a file enrols nothing twice.
`waitForImport` rejects with a `StowTimeoutError` at `timeoutMs` and a `StowAbortError` when its
`signal` aborts; the job carries on either way, and `members.getImport(job.id)` reads it later.
Instead of polling, you can listen for the `batch.completed` and `batch.failed` webhooks: their
`data.batchJobId` is the job's `id`.

`startImport` is not retried after a network error or `5xx`, since a repeat could queue the same file
twice; a `429` is still retried.

## Pagination

List methods return a `PagePromise`. Await it for one page, or iterate it to walk every item:

```ts
const first = await stow.members.list({ pageSize: 100 });
console.log(first.total, first.items.length, first.hasNextPage());
const second = await first.getNextPage();

for await (const member of stow.members.list({ programId })) {
  // fetches further pages as needed
}

for await (const page of first.iterPages()) {
  console.log(page.page, page.items.length);
}
```

Lists are newest first and paginated by offset, so members enrolled while you iterate can shift items
between pages. De-duplicate by `id` when you need an exact export.

## Errors

Every error extends `StowError`. API failures are a `StowApiError` subclass chosen by status:

| Class                      | Status | Typical cause                                                                                             |
| -------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `BadRequestError`          | 400    | Validation failed; `BALANCE_NOT_ADJUSTABLE`; `REDEEM_NOT_AVAILABLE`.                                      |
| `AuthenticationError`      | 401    | `NO_TOKEN` (no key sent) or `INVALID_API_KEY` (unknown, expired or revoked).                              |
| `PaymentRequiredError`     | 402    | `BILLING_SUBSCRIPTION_REQUIRED`: renew the subscription in the console.                                   |
| `PermissionDeniedError`    | 403    | The key's roles lack the permission.                                                                      |
| `NotFoundError`            | 404    | No such resource in your merchant.                                                                        |
| `ConflictError`            | 409    | Member not active; `STAMP_CARD_FULL`; `REDEEM_NOT_ELIGIBLE`; concurrent change; `IDEMPOTENCY_KEY_IN_USE`. |
| `UnprocessableEntityError` | 422    | Semantically invalid request.                                                                             |
| `RateLimitError`           | 429    | `RATE_LIMITED`: rate limit exceeded; see `retryAfterMs`.                                                  |
| `InternalServerError`      | 5xx    | API failure, after automatic retries.                                                                     |

Transport failures are `StowConnectionError` (and its subclass `StowTimeoutError`); a call cancelled
through your `signal` rejects with `StowAbortError`. A `2xx` answer that is not an API response (an
HTML page from a proxy or a wrong `baseUrl`, say) is a `StowApiError` with `code`
`UNEXPECTED_RESPONSE`. Invalid arguments reject with a `TypeError` before any request is sent.

```ts
import { ConflictError, StowApiError } from '@stowcards/sdk';

try {
  await stow.members.redeemReward(memberId);
} catch (error) {
  if (error instanceof ConflictError && error.code === 'REDEEM_NOT_ELIGIBLE') {
    const { current, goal } = error.details; // extra fields from the API
    console.log(`Needs ${Number(goal) - Number(current)} more`);
  } else if (error instanceof StowApiError) {
    console.error(error.status, error.code, error.message, error.requestId);
  } else {
    throw error;
  }
}
```

Branch on `error.code`, which is stable. `error.message` comes from the API and may be localised (send
`Accept-Language` through `defaultHeaders`). Quote `error.requestId` when contacting support.

## Retries, idempotency and timeouts

The SDK retries a failed attempt up to `maxRetries` times (default 2) when repeating it is safe:

- network errors, timeouts, `408` and `5xx`, for reads and for writes that cannot apply twice;
- `429` (`code` `RATE_LIMITED`) for any request except a pass push, waiting for `Retry-After`. A wait
  longer than 60 seconds is not slept through: the `RateLimitError` is thrown at once with `retryAfterMs`.

Waits use exponential backoff with full jitter. A pass push (`pushPass`) is never retried at all, not
even after a `429` and whatever `maxRetries` says: every push alerts the customer. These are never
retried after a network error or `5xx`: a CSV import or import job (a repeat would report the already
enrolled rows as `deduped`, or queue the file twice), and creating, deleting, rotating, testing or replaying webhooks.
A `409` refusal (`CONFLICT`, `REDEEM_NOT_ELIGIBLE`, `STAMP_CARD_FULL`) is never retried either: some
refusals notify the customer, and repeating a status change refused because another request changed
the status first would overwrite that change. The one `409` the SDK does retry is
`IDEMPOTENCY_KEY_IN_USE` on its own retry of a keyed call: the earlier attempt it stopped waiting for
is still being processed, so it waits and repeats the request with the same key to get that answer.

**Balance and status changes are idempotent.** `adjustPoints`, `redeemReward` and `updateStatus`
always send an `Idempotency-Key`: the SDK generates one per call and reuses it across its own retries,
so a timeout followed by a retry can never award points twice. When your own process may retry a
gesture (after a crash, or from a job queue), pass a key derived from the gesture:

```ts
await stow.members.adjustPoints(memberId, { delta: 10 }, { idempotencyKey: `order-${order.id}` });
```

Keys are 8 to 128 characters of `[A-Za-z0-9_-]`, scoped to your merchant, so never reuse one for a
different call. A repeat of a completed request returns the stored response and
`response.idempotencyReplayed` is `true`. A repeat that arrives while the first request is still being
processed is refused with a `ConflictError` whose `code` is `IDEMPOTENCY_KEY_IN_USE`: retry the same
request with the same key shortly to get its answer.

A refused `redeemReward` or `adjustPoints` whose refusal shows the customer a wallet notice (such as
`REDEEM_NOT_ELIGIBLE`) is stored against its key in the same way: a retry with the same key replays the
refusal without a second notice. Use a new key for a new attempt, for example once the member has
earned enough for the reward.

Enrolment dedupes on `(programId, email)`, which makes it safe to retry. `deduped: true` can therefore
also mean that the first attempt succeeded before a retry. A retry that arrives while the first attempt
is still building the wallet passes waits for them (up to 20 seconds), so `passIssuance` and the links on a deduped
member reflect what the first attempt stored.

## Response metadata

Methods that return one result return an `ApiPromise`. Await it for the data, or call
`.withResponse()` for the metadata too:

```ts
const { data: member, response } = await stow.members.get(memberId).withResponse();
response.requestId; // correlation id for support
response.rateLimit; // { limit, remaining, resetSeconds }
response.attempts; // 1 unless the SDK retried
response.idempotencyReplayed; // true when a stored response was replayed
```

List methods return a `PagePromise`; each awaited `Page` carries the same metadata as `page.response`.
`findByCode` resolves to the member (or `null`) directly; `findByEmail` and `findByPhone` return pages.

## Webhooks

Create a subscription and store its secret, which is shown only once:

```ts
const subscription = await stow.webhooks.create({
  name: 'Order system',
  url: 'https://example.com/stow/webhooks',
  events: ['member.created', 'points.changed', 'reward.redeemed'],
});
saveSecret(subscription.secret);
await stow.webhooks.test(subscription.id); // queues a signed test delivery
```

Verify every delivery over the **raw** request body before trusting it:

```ts
import express from 'express';
import { WebhookVerificationError, constructWebhookEvent, isWebhookTestEvent } from '@stowcards/sdk';

// Fail at startup, not on every delivery, when the secret is missing.
const secret = process.env.STOW_WEBHOOK_SECRET;
if (!secret) throw new Error('Set STOW_WEBHOOK_SECRET.');

const app = express();

app.post('/stow/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = constructWebhookEvent({ payload: req.body, headers: req.headers, secret });
  } catch (error) {
    // Only a failed verification is the sender's fault; anything else is a bug to surface.
    if (error instanceof WebhookVerificationError) return res.sendStatus(400);
    throw error;
  }

  // stow.webhooks.test() deliveries carry only { test, subscriptionId, sentAt }.
  if (isWebhookTestEvent(event)) return res.sendStatus(204);

  switch (event.event) {
    case 'points.changed':
      console.log(event.data.memberCode, event.data.previous, '->', event.data.current);
      break;
    case 'member.created':
      console.log('welcome', event.data.email);
      break;
    default:
      break; // new event types can appear: ignore what you do not handle
  }
  res.sendStatus(204);
});
```

- The signature is checked in constant time, and deliveries signed more than 5 minutes away from now are
  rejected as possible replays (`toleranceMs` changes the window).
- Deliveries are at least once: dedupe on `event.eventId`, which survives retries and replays.
- Rotating takes effect at once: deliveries are signed with the new secret straight away, and your
  receiver rejects them until it has it. Keep that window short (read secrets from a store you update
  right after `rotateSecret`), accept both secrets meanwhile (`secret: [newSecret, oldSecret]`, for
  retries signed before the rotation), then resend what failed: `listDeliveryLogs({ success: false })`
  and `replayDelivery(logId)`.
- `generateWebhookTestHeaders({ payload, secret })` signs a payload for your handler's tests.
- Inspect and resend deliveries with `stow.webhooks.listDeliveryLogs()` and
  `stow.webhooks.replayDelivery(logId)`.

## Logging

The SDK is silent below `warn` by default. Set `STOW_LOG=debug` (or `logLevel: 'debug'`) to log each
attempt, status, duration and request id, and `info` to log retries. Log lines never contain the API
key, request or response bodies, or query strings (a search query can be an email address).

```ts
import pino from 'pino';
const stow = new StowClient({ logger: pino(), logLevel: 'info' });
```

## API coverage

| Method                                                             | Endpoint                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `programs.list()`                                                  | `GET /merchants/me/programs`                              |
| `programs.get(id)`                                                 | `GET /merchants/me/programs/{id}`                         |
| `members.enroll(params)`                                           | `POST /merchants/me/members`                              |
| `members.list(params)`                                             | `GET /merchants/me/members`                               |
| `members.findByCode(code)`                                         | `GET /merchants/me/members?memberCode=`                   |
| `members.findByEmail(email)`                                       | `GET /merchants/me/members?email=`                        |
| `members.findByPhone(phone)`                                       | `GET /merchants/me/members?phone=`                        |
| `members.get(id)`                                                  | `GET /merchants/me/members/{id}`                          |
| `members.listTags()`                                               | `GET /merchants/me/members/tags`                          |
| `members.addTags(id, tags)` / `removeTags(id, tags)`               | `POST` / `DELETE /merchants/me/members/{id}/tags`         |
| `members.import(params)`                                           | `POST /merchants/me/members/import`                       |
| `members.startImport(params)`                                      | `POST /merchants/me/members/import-jobs`                  |
| `members.getImport(jobId)` / `waitForImport(jobId)`                | `GET /merchants/me/members/import-jobs/{jobId}`           |
| `members.listImportRows(jobId, params)`                            | `GET /merchants/me/members/import-jobs/{jobId}/rows`      |
| `members.adjustPoints(id, params)`                                 | `PATCH /merchants/me/members/{id}/points`                 |
| `members.redeemReward(id, params)`                                 | `POST /merchants/me/members/{id}/redeem`                  |
| `members.updateStatus(id, params)`                                 | `PATCH /merchants/me/members/{id}/status`                 |
| `members.pushPass(id)`                                             | `POST /merchants/me/members/{id}/push`                    |
| `members.listEvents(id)`                                           | `GET /merchants/me/members/{id}/events`                   |
| `members.listTransactions(id)`                                     | `GET /merchants/me/members/{id}/transactions`             |
| `webhooks.list()` / `create()` / `get()` / `update()` / `delete()` | `/merchants/me/webhooks[/{id}]`                           |
| `webhooks.rotateSecret(id)` / `test(id)`                           | `POST /merchants/me/webhooks/{id}/rotate-secret` / `test` |
| `webhooks.listDeliveryLogs()` / `replayDelivery(logId)`            | `/merchants/me/webhooks/delivery-logs[/{logId}/replay]`   |

API keys are created and revoked in the console, and customers who sign up themselves use your hosted
enrolment page; neither is part of the API. From a backend, enrol with `members.enroll`.

## Security

- Keep API keys in a secrets manager and rotate them: create the new key, deploy it, then revoke the old
  one in the console.
- The SDK sends the key only over HTTPS (localhost excepted), never follows redirects, so the key cannot
  be forwarded to another host, and never logs it or puts it in errors.
- Report vulnerabilities privately as described in
  [SECURITY.md](https://github.com/StowCards/stow-examples/blob/main/SECURITY.md).

## Versioning and support

Versions stay on **1.0.x**: every release, whether it adds a feature or fixes a bug, bumps the last
number, and every change is listed in the [changelog](https://github.com/StowCards/stow-examples/blob/main/node/CHANGELOG.md).
Releases only ever add to the public API, which is tracked in
[`review/stowcards-sdk.api.md`](https://github.com/StowCards/stow-examples/blob/main/node/review/stowcards-sdk.api.md):
existing methods, options and types keep working, so `npm install @stowcards/sdk@^1.0.0` always takes a
safe update. Fields the API adds to responses and new webhook event types are additions too.

Each Node.js release line is supported until its upstream end of life; dropping a line is announced in
the changelog. See [SUPPORT.md](https://github.com/StowCards/stow-examples/blob/main/node/SUPPORT.md) for where to get
help.

## Contributing

Issues and pull requests are welcome. Read
[CONTRIBUTING.md](https://github.com/StowCards/stow-examples/blob/main/node/CONTRIBUTING.md) and the
[Code of Conduct](https://github.com/StowCards/stow-examples/blob/main/CODE_OF_CONDUCT.md) first.

## License

Licensed under the [Apache License, Version 2.0](https://github.com/StowCards/stow-examples/blob/main/node/LICENSE). See
[NOTICE](https://github.com/StowCards/stow-examples/blob/main/node/NOTICE).
