# PHP example

The Stow Cards loyalty loop in plain PHP, against the public REST API: list
programs, enrol a member, award points, read the member back.

## Prerequisites

- PHP 8.2 or later with `ext-curl` (`php -m` lists it; `ext-json` is built
  in). PHP 8.1 reached end of life on 31 December 2025, and the client relies
  on 8.2's `#[\SensitiveParameter]` and `SensitiveParameterValue` to keep the
  key out of dumps and stack traces. No Composer packages.
- A published program with status `active` (web console, Pass Designer).
- An API key (web console, Administration, API Keys) whose role has these
  four permissions:
  - `merchants.programs:view` (list programs)
  - `merchants.members:create` (enrol the member)
  - `merchants.members:edit` (the points change)
  - `merchants.members:view` (the read-back)

Each run enrols a new member and issues its wallet passes, so use a test
workspace rather than one with real customers.

## Run

```bash
export STOW_API_KEY="stow_replace_with_your_key"
# Optional. Defaults to production; a local gateway is http://localhost:6060/api/v1
export STOW_BASE_URL="https://api.stow.cards/api/v1"
php demo.php
```

Without a local PHP, use Docker's official image (`php:8.2-cli` works too).
`-e STOW_API_KEY` copies the key from your shell, so it never appears on the
command line:

```bash
docker run --rm -v "$PWD":/app -w /app -e STOW_API_KEY -e STOW_BASE_URL php:8.4-cli php demo.php
```

Inside the container, `localhost` is the container itself, so reach a
gateway on your machine as `http://host.docker.internal:6060/api/v1`. On
Linux, add `--add-host=host.docker.internal:host-gateway` to the
`docker run` command.

The base URL must use `https`. Plain `http` is accepted only for
`localhost`, `127.0.0.1`, `[::1]`, names ending in `.localhost` and
`host.docker.internal`. A base URL with credentials, a query string, a
fragment or an invalid port (an empty one too, as in `localhost:/api/v1`)
is refused, and trailing slashes are removed.

Progress, including each retry notice, goes to stdout. An error goes to
stderr as one line, after everything already printed: every run of spaces
and line breaks in it, U+0085, U+2028 and U+2029 included, becomes one
space, and bytes that are not valid UTF-8 become U+FFFD. `demo.php` exits with
0 on success, 1 on an API or connection error and 2 on a configuration
error (no key, a key with spaces, line breaks or curly quotes, a refused
base URL, or PHP older than 8.2).

## Files

| File | Contents |
|---|---|
| `StowClient.php` | The client: authentication, envelope unwrapping, retries, idempotency keys |
| `StowException.php` | The exception every failed call throws |
| `demo.php` | The four-step flow |

## Sample output

Against a stub-mode gateway that failed the first points attempt with a
`503`:

```text
1. Listing programs
   skipping "Archived Card" (archived)
   using "Harbor Coffee Rewards" (6a0000000000000000000002)
2. Enrolling a member
   enrolled dev+1793004584907@example.com
3. Awarding 10 points
   PATCH /merchants/me/members/201fe644-960f-4227-92ee-169e9d512fd4/points failed (503 SERVICE_UNAVAILABLE); retry 1 of 2 in 14 ms
   balance 50 -> 60
4. Reading the member back
   Member ID:     8Y24Y6RXC9
   Balance:       60 points
   Apple Wallet:  https://api.stow.cards/wallet/getpass/201fe644-960f-4227-92ee-169e9d512fd4.pkpass (mode: stub)
   Google Wallet: https://pay.google.com/gp/v/save/STUB-201fe644-960f-4227-92ee-169e9d512fd4 (mode: stub)
   Stub mode: wallet credentials are not configured, so no pass update reaches a device.
```

With a key that is wrong or revoked (the last line is on stderr):

```text
1. Listing programs
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id a4c606da-c67f-4511-89a9-8bc35e1c5ea8)
```

When no response arrives (here, `localhost` from inside the container):

```text
1. Listing programs
   GET /merchants/me/programs failed (CONNECTION_ERROR); retry 1 of 2 in 36 ms
   GET /merchants/me/programs failed (CONNECTION_ERROR); retry 2 of 2 in 419 ms
Error: CONNECTION_ERROR: Could not reach the API: Failed to connect to localhost port 6222 after 0 ms: Could not connect to server
```

## Use the client in your code

```php
require __DIR__ . '/StowClient.php';

try {
    $stow = StowClient::fromEnvironment(); // or new StowClient($apiKey, $baseUrl)

    $member = $stow->enrollMember([
        'programId' => $programId,
        'firstName' => 'Ada',
        'lastName' => 'Lovelace',
        'email' => 'ada@example.com',
    ]);

    // Store the key with the order, so a retry after a crash reuses it.
    $key = StowClient::uuidV4();
    $stow->adjustPoints($member['id'], ['delta' => 10, 'changeMessage' => 'Thanks for visiting!'], $key);
} catch (InvalidArgumentException $e) {
    error_log('Configuration error: ' . $e->getMessage());
} catch (StowException $e) {
    if ($e->errorCode === 'STAMP_CARD_FULL') {
        // Redeem the reward first.
    }
    error_log($e->summary());
}
```

`request($method, $path, $body, $retryable, $idempotencyKey)` reaches any
other endpoint and returns the envelope's `data` as PHP arrays (JSON objects
become associative arrays), or `null` for a `204 No Content`. Only GET calls
are retried unless you pass `retryable: true` (see Retries).

## Notes

### Idempotency

A points change carries an `Idempotency-Key` (8 to 128 characters of
`A-Z a-z 0-9 _ -`; a UUID works well). Make one key per gesture, such as one
award at the till, and reuse it for every retry of that gesture. The client
resends it on its own retries; if your process retries later, pass the same
key again. A retry of a completed request replays the stored answer, so the
points are added once. Keys are scoped to your merchant, not to the
endpoint, so never reuse one for a different call.

`409 IDEMPOTENCY_KEY_IN_USE` means an earlier request with the same key is
still being processed. The client waits for its own earlier attempt (see
Retries); if you get this error from a first attempt, another call holds the
key, so retry the same call with the same key shortly to get its answer.

Enrolment takes no key. It dedupes on (programId, email): a repeat returns
the existing member with HTTP 200 and `"deduped": true`, which counts as
success.

### Retries

- At most 2 retries per call (`maxRetries`, 0 or more), so at most 3
  requests. curl sends each attempt once: every attempt uses HTTP/1.1 on a
  new connection that is closed afterwards, and never sends
  `Expect: 100-continue`. With its defaults, libcurl resends a POST or PATCH
  by itself after a refused HTTP/2 stream, on a reused connection the server
  has dropped, or after a `417`; these settings leave it no such case.
- Each attempt is limited to 30 s (`timeoutSeconds`, a positive whole
  number), covering connecting, sending and reading the whole response body.
  Connecting alone is limited to 10 s.
- Retried: network errors, timeouts, `408`, `429`, `500`, `502`, `503` and
  `504` (also when the error body cannot be decoded), for GET calls, the
  points PATCH (same key) and enrolment (it dedupes). Anything else sent
  through `request()`, even with an `Idempotency-Key`, is not retried unless
  you pass `retryable: true`.
- One `409` is retried: `IDEMPOTENCY_KEY_IN_USE`, and only when the request
  carried an `Idempotency-Key` and the attempt that got it was itself a
  retry. That means the client's own earlier attempt (one that timed out or
  got a `5xx`, say) still holds the key, so it waits with the normal backoff
  and resends the same key to receive the stored answer. A `409` on a first
  attempt is never retried.
- Never retried: any other `4xx`, `501` and any other `5xx`, a redirect, and
  a response that is not the API's.
- The wait is exponential backoff with full jitter (a random 0 to 500 ms,
  then 0 to 1 s, doubling up to 8 s), or the server's `Retry-After`, given
  either as seconds (a whole or decimal number such as `2`, `1.5`, `.5` or
  `5.`, with no sign or exponent) or as an HTTP date. A `Retry-After`
  above 60 s is not waited out: the call fails at once with that response's
  error (for example `429 RATE_LIMITED`) so your code can decide. A
  `Retry-After` the client cannot read is ignored and the normal backoff
  applies.
- Pass an `onRetry` closure to log each retry, as `demo.php` does.

The gateway rate-limits per client IP address (1000 requests per 15 minutes
by default), shared with all other traffic from that address.

### Errors

Every failed call throws `StowException`:

| Member | Meaning |
|---|---|
| `status` | HTTP status, or 0 when no response arrived |
| `errorCode` | The API's `error.code` (`INVALID_API_KEY`, `NOT_FOUND`, `STAMP_CARD_FULL`, ...), or the top-level `code` of the flat `{"error": "message", "code": "..."}` body that older gateways sent. `HTTP_<status>` when the error body has none (or an empty or blank one). Without a response: `CONNECTION_ERROR` or `TIMEOUT`. `UNEXPECTED_RESPONSE` for a 2xx that is not the API's envelope (usually a base URL without `/api/v1`), whose body cannot be decoded, or whose `data` has the wrong shape: a list where an object is needed, a program without a non-empty string `_id`, or an enrolled or fetched member whose `id` is not a string that can go into a path (missing, blank, `.` or `..`). `UNEXPECTED_REDIRECT` for any 3xx, whatever its body; it is never followed |
| `getMessage()` | For example `401 INVALID_API_KEY: Invalid or expired API key.` The message is `error.message`, or the `error` string of the flat body. When there is none (or an empty or blank one): the trimmed body (at most 500 characters) if it is not JSON or is a bare JSON string such as `"Service down"`, otherwise `Request failed with status <n>`, which is also the message when the body cannot be decoded |
| `details` | Any other fields of the error object (of the body, for the flat shape) |
| `requestId` | The `X-Correlation-Id` response header; quote it to support |
| `summary()` | The message and request id on one line, or the message alone when the response had no request id |

The status is judged before the body: an error status keeps its code and
retry rules even when its body cannot be decoded (a `503` with a corrupt
body is still a `503` and is retried). Branch on `errorCode`, never on the
message, which the server may translate. Configuration problems (no key, an
invalid key, a refused base URL, a negative `maxRetries`, a
`timeoutSeconds` below 1) and a member id that is empty, blank, `.` or
`..` throw `InvalidArgumentException` before any request is sent.

### The API key

The client trims surrounding whitespace from the key, including a
no-break space or other Unicode space picked up when copying it from a web
page, and then accepts only visible ASCII characters; any other key is
refused with a message that does not contain it. The key is
held in a `SensitiveParameterValue`, so `var_dump`, `print_r`, `var_export`
and `debug_zval_dump` of the client never show it, and `serialize()` of the
client throws. It never shows in an exception trace: the parameters that
receive it (the constructor's and the trim helper's) are marked
`#[\SensitiveParameter]` (traces show `Object(SensitiveParameterValue)`),
and the `X-API-Key` header is added only where the request is sent.
Reflection on the private property can still read it.

### Stub mode

Without Apple or Google wallet credentials (usual on a local gateway) the
loop still works, but the passes are placeholders and no update reaches a
device. `apple.mode` and `google.mode` on the member say `"stub"`; `"real"`
means a real credential signed the pass. Read these fields and never infer
the mode from the pass URL, which is the same in both modes.

### Member identity and balance

Show `memberCode` to people and label it "Member ID". `id` (a UUID) is for
API paths only and `serialNumber` is wallet plumbing; never show either as
the member's ID. Programs are keyed by `_id`, members by `id`.

The balance sits in `fieldValues` under a key: the member's
`program.balanceKey`, else the listed program's `balanceKey`, else
`points`. The demo reads only that key and prints `n/a` when `fieldValues`
has no entry for it. A balance can arrive as a numeric string such as `"0"`.
