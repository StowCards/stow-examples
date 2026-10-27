# Go example

Runs the Stow Cards loyalty loop against the public REST API, using the Go
standard library only: list programs, enrol a member, award points and read
the member back.

| File | What it is |
|---|---|
| `stow/client.go` | A small reusable client (package `stow`): configuration, retries, errors and the four calls |
| `main.go` | The runnable flow |
| `go.mod` | Module `stowcards.example/quickstart`, no dependencies |

## Prerequisites

- Go 1.22 or later.
- A published program with status `active` on your merchant (web console >
  Pass Designer).
- An API key (web console > Administration > API Keys) whose role has these
  four permissions:
  - `merchants.programs:view` (list programs)
  - `merchants.members:create` (enrol the member)
  - `merchants.members:edit` (the points change)
  - `merchants.members:view` (read the member back)

## Run

```bash
export STOW_API_KEY="stow_replace_with_your_key"
export STOW_BASE_URL="https://api.stow.cards/api/v1"   # optional; this is the default
go run .
```

`STOW_API_KEY` is required. After surrounding whitespace is trimmed (the
whitespace JavaScript's `trim()` removes, as the Node.js SDK does, so Unicode
spaces such as a no-break space go too) it may contain only visible ASCII
characters, so a key pasted with a line break or a curly quote inside it is
refused before any request is made. The key is never printed:
error messages leave it out, and printing a `stow.Client` with `fmt` (`%v`,
`%+v`, `%#v`) shows `apiKey: [redacted]`.

`STOW_BASE_URL` must use `https://`. Plain `http://` is accepted only for a
local gateway: `localhost`, `127.0.0.1`, `[::1]`, a name ending in
`.localhost`, or `host.docker.internal`, such as
`http://localhost:6060/api/v1`. Of the IPv6 addresses only the literal `[::1]`
is accepted, not another spelling of it such as `[0:0:0:0:0:0:0:1]`. A user
name or password, a query, a fragment or an invalid port (an empty one
included, as in `http://localhost:/api/v1`) is refused. Trailing slashes are
dropped.

Each run enrols a new member, `dev+<unix-ms>@example.com`, on the merchant
the key belongs to, and issues that member real wallet passes when the server
has wallet credentials. Use a test merchant.

## Sample output

From a server without wallet credentials, so both wallets report stub mode:

```text
Program:       Harbor Coffee Rewards (6a0000000000000000000002), first active of 2
Enrolled:      dev+1793004623682@example.com
Points:        50 -> 60 (Idempotency-Key 7b41c08d-9fc7-412c-9d9e-7b63d0ac6504)
Member ID:     KF936MMDAV
Balance:       60 (fieldValues.points)
Apple Wallet:  https://api.stow.cards/wallet/getpass/446f18dd-1b7f-4c7d-8c5d-38d9a0244ce7.pkpass (mode: stub)
Google Wallet: https://pay.google.com/gp/v/save/STUB-446f18dd-1b7f-4c7d-8c5d-38d9a0244ce7 (mode: stub)
Stub mode: wallet credentials are missing on this server, so pass updates reach no phone.
```

If the email was already enrolled in the program, the API returns the
existing member with `deduped: true` (HTTP 200) and the example says so.

The balance is read from `fieldValues` under one key: the member's
`program.balanceKey`, else the listed program's `balanceKey`, else `points`.
The line names the key used and shows `n/a` when that entry is missing.

## Notes

### Member ID

The value to show staff and customers is `memberCode`, labelled "Member ID".
The member's `id` (a UUID) is only for API paths, and `serialNumber` is wallet
plumbing: never show either as the member's ID. Programs are keyed by `_id`,
members by `id`. `AdjustPoints` and `GetMember` return an error without
sending anything when the member id is empty, only whitespace, `.` or `..`
(the last two would resolve to another endpoint in the path).

The balance lives in `fieldValues` under the program's `balanceKey`
(`points`, `stamps`, ...) and can arrive as a number or a numeric string;
`Member.Balance` reads both.

### Idempotency

A points change carries an `Idempotency-Key`. Make one key per logical
gesture with `stow.NewIdempotencyKey()` (a UUID v4) and pass it to
`AdjustPoints`, which refuses a key that is not 8 to 128 characters of
`[A-Za-z0-9_-]`. The client resends the same key on its own retries, and you
pass the same key again if you repeat the gesture yourself, for example after
a crash. The server then replays the stored answer instead of applying the
change twice. Never reuse a key for a different change: keys are scoped to
your merchant, not to the endpoint.

### Retries

Each attempt has a 30 second timeout that covers connecting, sending the
request and reading the whole response, so a server that stalls part-way
through a body ends that attempt after 30 seconds. A network error, a timeout,
`408`, `429`, `500`, `502`, `503` or `504` is retried at most twice, with
exponential backoff and full jitter (a random wait below 500 ms, then below
1 s). A `Retry-After` header, in seconds (plain digits with an optional
decimal point, such as `5`, `5.0`, `5.` or `.5`) or as an HTTP date, replaces
that wait when it is 60 seconds or less; a longer one returns
the error at once, with the wait in `APIError.RetryAfter`. A `Retry-After`
value that cannot be read is ignored and the normal backoff applies. One call
can therefore take up to three 30 second attempts plus the waits between them.
Cancelling the `context.Context` stops the call, including while it waits
between attempts (the example cancels on Ctrl+C).

One `409` is retried: `IDEMPOTENCY_KEY_IN_USE` on a request that carried an
`Idempotency-Key`, when the attempt that got it was itself a retry. It means
the client's own earlier attempt (one that timed out or got a `5xx`, say) is
still being processed, so the client waits with the same backoff and sends the
same key again to collect that attempt's answer. On a first attempt the same
code means another call of yours holds the key, so it is returned to you: call
`AdjustPoints` again with the same key shortly to get its answer. Every other
`4xx`, and `501` and any other `5xx`, is returned at once and never retried.

Only calls that are safe to repeat are retried. A `GET` always is; any other
request only when the method that sends it marks it safe, as `EnrollMember`
(enrolment dedupes on `(programId, email)`) and `AdjustPoints` (the points
change runs once per `Idempotency-Key`) do. A call you add to the package is
therefore sent once unless you mark it too, even if it carries an
`Idempotency-Key`. Set `Client.OnRetry` to see retries; the example prints
them to stdout with its progress:

```text
  retry 1 of 2 for PATCH /merchants/me/members/7b3d939e-5f2c-4906-a2ef-4f00cb8cad66/points in 343ms after: 503 SERVICE_UNAVAILABLE: Upstream unavailable (mock fault mode). (request id 7a1afce8-8f84-4d40-995b-c21edaff4e99)
```

The client stops `net/http` from resending the enrolment and the points
change by itself, so every resend of those is one of the counted retries
above. A `GET` is different: when a reused keep-alive connection closes before
any response arrives, `net/http` resends the `GET` on another connection
without telling the client, and that resend is neither counted nor reported
to `OnRetry`. A `GET` can therefore reach the server more than three times.
`net/http` has no setting to switch this off; it is harmless because the
reads change nothing.

### Errors

The client unwraps `{ "success": true, "data": ... }`. A failed call returns
one of two error types:

- `*stow.APIError` when a response arrived: the HTTP status, `error.code`,
  `error.message`, any extra fields of the error object in `Details`, and the
  request id from the `X-Correlation-Id` response header. Quote the request id
  to support. The flat body older gateways sent, `{ "error": "<message>",
  "code": "<code>" }`, is read as the Node.js SDK reads it: the message is
  the `error` text and the code is the top-level `code`. A code that is
  missing, empty or only whitespace gives `HTTP_<status>`. When the message
  is missing or empty, a body that is not JSON, or is a bare JSON string,
  gives its trimmed text (up to 500 characters) as the message; any other
  body gives `Request failed with status <n>`. An error status
  whose body cannot be decoded is judged on its status alone, so a `503` with
  a corrupt gzip body is still a `503` that is retried.
- `*stow.ConnectionError` when none did: `Code` is `TIMEOUT` when the last
  attempt ran out of time, `CONNECTION_ERROR` otherwise.

```go
var apiErr *stow.APIError
if errors.As(err, &apiErr) {
	switch apiErr.Code {
	case "INVALID_API_KEY", "NO_TOKEN":
		// fix the key
	case "BILLING_SUBSCRIPTION_REQUIRED":
		// renew the subscription in the web console
	}
	log.Printf("%d %s (request id %s)", apiErr.Status, apiErr.Message, apiErr.RequestID)
}
```

A `2xx` answer that is not the API's success envelope, carries no `data`
where the call needs it, has `data` of the wrong shape (an object where a
list is needed, or the reverse), lacks an id the flow goes on to use (a
program's `_id`, the enrolled or read-back member's `id`, where an `id` that
is only whitespace counts as missing), or has a body that
cannot be decoded (a corrupt gzip body, say) is an `APIError` with code
`UNEXPECTED_RESPONSE`, so no later request goes out with an empty id; an HTML
page from a proxy or a wrong base URL is the usual cause. A `204` is a success
with no data, which these four calls report as `UNEXPECTED_RESPONSE` because
each needs data. A `3xx` is never followed, so the key is never sent to
another host: it is an `APIError` with code `UNEXPECTED_REDIRECT`, whatever
its body.

The example prints progress to stdout and one error line to stderr, then
exits with status 2 for a configuration error, 1 for an API or connection
error and 130 when interrupted with Ctrl+C. A missing key, a revoked key and a
gateway that is not running end with these lines on stderr (the last after two
retry lines on stdout); an error line has no `(request id ...)` when the
response carried no `X-Correlation-Id`:

```text
Configuration error: STOW_API_KEY is not set: create an API key in the web console (Administration > API Keys) and export it
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id 48ee8c14-5b4a-45f5-abeb-52d8b0d29c00)
Error: CONNECTION_ERROR: GET /merchants/me/programs: dial tcp [::1]:6227: connect: connection refused
```

`go run` adds a line of its own, such as `exit status 2`, and then exits with
1 whatever the example's status was. To get the example's own exit status,
build it first (`bin/` is ignored by git):

```bash
go build -o bin/quickstart . && ./bin/quickstart
echo $?
```

### Stub mode

A server without Apple or Google wallet credentials runs in stub mode: the
whole flow still works, but wallet updates reach no phone. `apple.mode` and
`google.mode` on the member say `"stub"` (or `"real"`). Read those fields;
never infer the mode from the pass URL, which looks the same in both modes.
