# .NET example

A .NET 10 console app that runs the Stow Cards loyalty loop against the public
REST API, with a small reusable client you can copy into your own project. It
uses only `HttpClient` and `System.Text.Json`: no NuGet packages.

```
list programs → enroll a member → award 10 points (idempotent) → read the member back
```

1. Lists the merchant's programs and picks the first one whose `status` is
   `active`.
2. Enrols `dev+<unix-ms>@example.com` (Ada Lovelace, 50 initial points), so
   every run creates a fresh member.
3. Awards 10 points with `PATCH /merchants/me/members/{id}/points` and an
   `Idempotency-Key`.
4. Reads the member back and prints the Member ID, the balance, both wallet
   links and the wallet modes.

## Prerequisites

- The [.NET 10 SDK](https://dotnet.microsoft.com/download/dotnet/10.0).
- An API key (web console → Administration → API Keys) whose roles grant the
  four permissions the demo needs:
  - `merchants.programs:view`: list the programs (step 1);
  - `merchants.members:create`: enrol the member (step 2);
  - `merchants.members:edit`: the points change (step 3);
  - `merchants.members:view`: read the member back (step 4).
- At least one published, active program on the merchant the key belongs to
  (web console → Pass Designer).

## Files

| File | What it is |
|---|---|
| `StowClient.cs` | The reusable client: auth headers, timeouts, retries, envelope unwrapping |
| `StowApiException.cs` | The exception thrown when the API answers with an error, or does not answer |
| `Models.cs` | Records for the requests and responses the example uses, and the converter that reads a wrongly typed optional field as absent |
| `Program.cs` | The demo (`dotnet run`) |
| `StowCards.Example.csproj` | Targets `net10.0`, nullable on, warnings treated as errors |

## Run it

```bash
cd dotnet  # from the root of the examples
export STOW_API_KEY="stow_your_key_here"
# Optional; this is the default:
export STOW_BASE_URL="https://api.stow.cards/api/v1"
dotnet run
```

`STOW_BASE_URL` must use `https`. Plain `http` is accepted only when the host
is `localhost`, `127.0.0.1`, `[::1]`, a name ending in `.localhost` or
`host.docker.internal` (in any letter case), so the key never crosses a network
unencrypted. A base URL with credentials (`user@`), a query string, a fragment
or an invalid port (an empty one, as in `localhost:`, included) is refused, and
trailing slashes are dropped.

`STOW_API_KEY` is trimmed of surrounding whitespace, the same characters the
Node SDK's `trim()` removes (ASCII whitespace, Unicode spaces such as the
no-break space U+00A0, U+2028, U+2029 and U+FEFF), and must then be visible
ASCII only: a key with a space, a line break or a curly quote left inside it
after copying is a configuration error. The key itself is never printed, not
even in part.

Progress goes to stdout. An error is one line on stderr, written after stdout
is flushed; every line break and other whitespace character in it (U+0085,
U+2028 and U+2029 included) becomes a single space:

| Line | When | Exit code |
|---|---|---|
| `Configuration error: <message>` | `STOW_API_KEY` missing or malformed, `STOW_BASE_URL` refused | `2` |
| `Error: <status> <CODE>: <message> (request id <id>)` | the API answered with an error (the request id part only when the response carried `X-Correlation-Id`) | `1` |
| `Error: CONNECTION_ERROR: <message>` or `Error: TIMEOUT: <message>` | no response arrived | `1` |
| `Error: none of the <n> programs is active. …` | the merchant has no active program | `1` |

Ctrl+C prints `Cancelled.` and exits `130`.

## Sample output

A run against a local test gateway in stub mode, where the first points
attempt answered `503` and the client retried it with the same
`Idempotency-Key`:

```
Stow Cards API at http://127.0.0.1:6235/api/v1
   skipping "Archived Card" (archived)
1. Program: "Harbor Coffee Rewards" (6a0000000000000000000002)
2. Enrolled dev+1793008608846@example.com
   ... PATCH /merchants/me/members/db3c45e6-2173-4835-897a-eca2c700554d/points: 503 SERVICE_UNAVAILABLE; retry 1/2 in 420 ms
3. Awarded 10 points: 50 -> 60 (Idempotency-Key a4a5e5ca-c6b3-4e6f-919b-f0cc76b0820a)
   pass update: apple stub, 0/0 devices notified; google stub, object patched: no
4. Member:
   Member ID     UXET9YCS23
   Balance       60 (points)
   Apple pass    https://api.stow.cards/wallet/getpass/db3c45e6-2173-4835-897a-eca2c700554d.pkpass
   Google pass   https://pay.google.com/gp/v/save/STUB-db3c45e6-2173-4835-897a-eca2c700554d
   Wallet modes  apple=stub, google=stub
   (stub: that wallet's credentials are not configured, so no update reaches a phone)
```

With an invalid key, against the same gateway (the first line is stdout, the
second stderr):

```
Stow Cards API at http://127.0.0.1:6235/api/v1
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id b9d4e79d-4103-4e00-ab64-f581fc3f0cd6)
```

With a key that picked up a line break while being copied (exit code `2`):

```
Configuration error: The API key (STOW_API_KEY) contains spaces, line breaks or non-ASCII characters such as curly quotes. Copy it again from the web console.
```

With nothing listening at `STOW_BASE_URL` (the retry notes are stdout, the
last line stderr, exit code `1`):

```
Stow Cards API at http://127.0.0.1:1/api/v1
   ... GET /merchants/me/programs: Connection refused; retry 1/2 in 463 ms
   ... GET /merchants/me/programs: Connection refused; retry 2/2 in 890 ms
Error: CONNECTION_ERROR: No response from http://127.0.0.1:1/api/v1 to GET /merchants/me/programs after 3 attempts: Connection refused
```

## Using the client in your own code

```csharp
using var stow = StowClient.FromEnvironment();   // or new StowClient(apiKey, baseUrl)

var member = await stow.EnrollMemberAsync(
    new EnrollMemberRequest(programId, "Ada", "Lovelace", "ada@example.com"), cancellationToken);

// One key per gesture. Store it with the order or visit, and reuse it if you retry later.
var key = Guid.NewGuid().ToString();
await stow.AdjustPointsAsync(member.Id, new AdjustPointsRequest(Delta: 10), key, cancellationToken);
```

Every method takes a `CancellationToken`. Create one `StowClient` and reuse it:
it owns an `HttpClient`.

## Notes

### Member identity

`memberCode` is the **Member ID**: the only member identifier to show to staff
or customers. Use `id` (a UUID) in API paths. `serialNumber` is wallet
plumbing, never a member's ID, so `Models.cs` does not map it at all. Programs
are keyed by `_id`; members, and the program snapshot inside a member, by `id`.

The balance is read from `fieldValues` under the program's `balanceKey`: the
one on the member's `program` snapshot, else the one on the program chosen in
step 1, else `points`. The demo prints the value stored under that one key,
labelled with it, or `n/a` when `fieldValues` has no such entry; it never shows
another key's value instead. The value can arrive as a number or as a numeric
string, and `Member.GetBalance(key)` reads either from that key only.

A `balanceKey` counts as missing only when it is absent, not a string or
empty; one made only of spaces is used as it is. A `program` snapshot or a
`fieldValues` that is not an object counts as absent too: `Models.cs` reads
such a field as `null` instead of refusing the whole response.

### Idempotency

A points change is money-like, so it carries an `Idempotency-Key` (8 to 128
characters of `A-Z a-z 0-9 _ -`; a UUID works). Make **one key per logical
gesture** and reuse it on every retry of that gesture: the API then replays
the stored answer instead of applying the change twice. Never reuse a key for
a different call; keys are scoped to your merchant, not to the endpoint.

The client sends the key you pass on each of its own retries. If your process
crashes mid-call, retry with the same key you stored.

Enrolment needs no key: it dedupes on `(programId, email)`. A repeat returns
the existing member with HTTP 200 and `deduped: true`, which the demo reports
and treats as success.

### Retries and timeouts

Each attempt has one 30-second deadline that covers connecting, sending the
request and reading the whole response body, so a server that stalls halfway
through a body cannot hold an attempt open. A failed attempt of a call that is
safe to repeat (below) is retried at most twice when it is a network error, a
timeout, or a `408`, `429`, `500`, `502`, `503` or `504`, with exponential
backoff and full jitter (a random wait up to
0.5 s, then up to 1 s). A call that never gets an answer therefore gives up
after about 91 seconds: three 30-second attempts plus the backoff.

When the server sends `Retry-After`, as delay-seconds (a plain decimal such as
`5`, `1.5`, `.5` or `5.`, with no sign or exponent) or as an HTTP date, the
client waits that long instead; if it asks for more than 60
seconds, the client gives up at once and throws, so the caller can decide. A
`Retry-After` it cannot read is ignored and the normal backoff applies. Every
other status, `501` and the other `5xx` included, is not retried, with the one
`409` exception below.

The client sends each call at most three times. Underneath it, .NET's
`SocketsHttpHandler` resends a request that has no body (the two `GET`s here)
on a new connection, up to three more times within one attempt, when the
server closes the connection before sending any response. In that one failure
a `GET` can reach the server up to 12 times. The `POST` and the `PATCH` are
never resent this way, and the handler has no setting that turns the resend
off.

The retry loop retries a `GET` by default. Any other call is retried only when
the method that sends it marks it safe to repeat, as `EnrollMemberAsync` (the
enrolment dedupes) and `AdjustPointsAsync` (the keyed points `PATCH`) do. A
call you add, such as `POST /merchants/me/members/{id}/push`, is sent once
unless you mark it, even when it carries an `Idempotency-Key`: a key makes a
retry safe only on an endpoint that honours it.

A `409` with `error.code` `IDEMPOTENCY_KEY_IN_USE` means an earlier request
with the same key is still running. The client retries it, with the same key
and the normal backoff, only when the request carried an `Idempotency-Key` and
the `409` answered one of the client's own retries: then the earlier request
holding the key is its own previous attempt (one that timed out, say), and the
next attempt receives that attempt's stored answer. A `409` on a first attempt
means another caller holds the key, so it is thrown at once; send the same
request with the same key again shortly to get its answer. Every other `409`
(`CONFLICT`, `STAMP_CARD_FULL`, `REDEEM_NOT_ELIGIBLE`) is a refusal and is
never retried.

Redirects are not followed, so the API key is never sent to another host: a
`3xx` throws at once, without its body being read, with `Code`
`UNEXPECTED_REDIRECT`.

### Errors

Every response uses one envelope: `{ "success": true, "data": … }` or
`{ "success": false, "error": { "code": …, "message": … } }`. The client
returns `data` and turns an error into a `StowApiException` with:

- `Status`: the HTTP status, or `0` when no response arrived (below).
- `Code`: `error.code`, such as `INVALID_API_KEY`, `NOT_FOUND`,
  `BALANCE_NOT_ADJUSTABLE` or `RATE_LIMITED`. Branch on this.
- `ApiMessage`: `error.message`, for display.
- `Details`: any other fields on the error object.
- `RequestId`: the `X-Correlation-Id` response header. Quote it to support.
- `RetryAfter`: the server's requested wait, when it sent one.

When the error object has no `code`, or an empty or blank one, `Code` is
`HTTP_<status>`. When it has no `message`, or an empty or blank one,
`ApiMessage` is `Request failed with status <n>`. Blank means nothing is left
after trimming what JavaScript's `trim()` removes, the same set as for the
key: U+00A0 and U+FEFF count as blank, U+0085 does not. A body is read as JSON
whenever it parses as JSON, whatever its `Content-Type`. The older flat shape
`{ "error": "<message>", "code": "<CODE>" }` is read the way the Node SDK
reads it: the `error` string is the message, a top-level `code` string the
code (else `HTTP_<status>`), and its other fields go to `Details`. When the
error body is not JSON (a proxy's page, say), or is a bare JSON string,
`ApiMessage` is that text, trimmed, up to its first 500 characters; any other
JSON that is not an object gives `Request failed with status <n>`. An error
body that cannot be decoded counts as empty, so the status still decides: a
`503` with a corrupt body is retried like any `503` and ends as `HTTP_503`
with `Request failed with status 503`.

These throw with `Code` `UNEXPECTED_RESPONSE`: a `2xx` that is not a
`{ "success": true, … }` envelope (a proxy's HTML page, or a base URL missing
`/api/v1`), one whose `data` is missing or not the shape the call needs (a
program whose `_id` is not a non-empty string, a member whose `id` is not a
string, is blank or is `.` or `..`, a list where an object is needed), a
`204 No Content` (a success with no data, but every call here needs data), and
a `2xx` body that cannot be decoded. The client sends no `Accept-Encoding`, but
decodes a `gzip`, `deflate` or `br` body a proxy compressed anyway; a corrupt
one, or any other encoding, cannot be decoded.

A call that never got an answer, once its retries are spent, throws a
`StowApiException` too, with `Status` `0`, no `RequestId` and `Code`
`CONNECTION_ERROR` (the connection failed or broke off) or `TIMEOUT` (no
complete response within 30 seconds); `InnerException` holds the cause. A
cancellation you asked for through the `CancellationToken` stays an
`OperationCanceledException`.

The constructor and `FromEnvironment` throw `ArgumentException` for a
malformed key or a refused base URL, and `FromEnvironment` throws
`InvalidOperationException` when `STOW_API_KEY` is not set. No message, and no
`ToString()` of the client or of any exception, contains the key.
`AdjustPointsAsync` and `GetMemberAsync` throw `ArgumentException`, before
sending anything, for a member id that is null, blank, `.` or `..` (a member id
goes in the path). A program id goes in a request body, so any non-empty
string is accepted, one made only of spaces included.

### Stub mode

A gateway without real Apple or Google wallet credentials runs in **stub
mode**: the whole loop still works, but wallet updates do not reach a phone.
The member's `apple.mode` and `google.mode` say `"stub"` in that case and
`"real"` otherwise. Read those fields; never infer the mode from the pass URL,
which looks the same in both modes.
