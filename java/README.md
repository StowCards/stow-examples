# Stow Cards API example: Java

A runnable Java example of the Stow Cards public REST API (OpenAPI spec 1.0.14). It runs the
loyalty loop server to server:

1. Lists the merchant's programs and picks the first with `status` `active`.
2. Enrols `dev+<unix-ms>@example.com` (Ada Lovelace, 50 starting points).
3. Awards 10 points with `PATCH /merchants/me/members/{id}/points` and an `Idempotency-Key`.
4. Reads the member back and prints the Member ID, the balance, the wallet links and the
   wallet modes.

It uses `java.net.http.HttpClient` and one dependency, Jackson databind.

## Prerequisites

- Java 17 or later.
- Maven 3.9 or later, or Docker (see below).
- A published program (web console, Pass Designer).
- An API key (web console, Administration, API Keys) with these four permissions:
  - `merchants.programs:view`, to list the programs;
  - `merchants.members:create`, to enrol the member;
  - `merchants.members:edit`, for the points change;
  - `merchants.members:view`, to read the member back.

Run against production, the example enrols a real member into your first active program and
issues real wallet passes for it, so point it at a test program.

## Run

```bash
export STOW_API_KEY="stow_replace_with_your_key"
export STOW_BASE_URL="https://api.stow.cards/api/v1"   # optional; this is the default

mvn -q compile exec:java
```

Without Maven installed, use the official Maven image. `-e NAME` with no value passes the
variable through from your shell, so the key never appears on the command line:

```bash
docker run --rm -v "$PWD":/app -w /app -v stow-example-m2:/root/.m2 \
  -e STOW_API_KEY -e STOW_BASE_URL \
  maven:3.9-eclipse-temurin-21 mvn -q compile exec:java
```

`exec:java` runs the demo inside Maven's own JVM, and some Maven installs send the program's
error line to stdout instead of stderr (the exit code is unaffected). To run it on a plain JVM,
as `tests/check.sh` does:

```bash
mvn -q compile dependency:build-classpath -Dmdep.outputFile=target/cp.txt
java -cp "target/classes:$(cat target/cp.txt)" cards.stow.example.Demo
```

The key is trimmed of the surrounding whitespace JavaScript's `trim()` removes, which includes
a no-break space picked up when copying from a web page, and must then be visible ASCII only:
a key with a space, a line break or a curly quote inside it (a bad paste) is refused before
any request, and the message never quotes it.

`STOW_BASE_URL`, trimmed the same way, must use `https://`. Plain `http://` is accepted
only for `localhost`, `127.0.0.1`, `[::1]`, names ending in `.localhost` and
`host.docker.internal`; the last is there only so a container can reach a gateway running
on the host (on Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`).
A URL with credentials, a query string, a fragment, or an invalid or empty port
(`http://localhost:/api/v1`) is refused, and trailing slashes are removed.

The example exits with status 0 on success, 1 on an API or connection error and 2 on a
configuration error (a missing or malformed key, or a refused `STOW_BASE_URL`). Progress,
including a line for each retry, goes to standard output; an error goes to standard error as
one line, after everything already printed, with every run of whitespace, line breaks
(U+0085, U+2028 and U+2029 included) and control characters in it turned into one space.

## Sample output

From a mock gateway in stub mode that fails the first points attempt with a `503`:

```text
API:       http://host.docker.internal:6234/api/v1
Skipped:   Archived Card (status archived)
Program:   Harbor Coffee Rewards (6a0000000000000000000002)
Enrolled:  Ada Lovelace <dev+1793006660585@example.com>
[stow] PATCH /merchants/me/members/38e1ac98-b1e2-4116-91e7-a81835372d3e/points: 503 SERVICE_UNAVAILABLE; retry 1 of 2 in 482 ms
Awarded:   10 points (50 -> 60)

Member ID: RJRTDHW4XX
Balance:   60 (fieldValues.points)
Apple:     https://api.stow.cards/wallet/getpass/38e1ac98-b1e2-4116-91e7-a81835372d3e.pkpass (mode: stub)
Google:    https://pay.google.com/gp/v/save/STUB-38e1ac98-b1e2-4116-91e7-a81835372d3e (mode: stub)
Stub mode: wallet credentials are not configured, so no update reaches a device.
```

With an invalid key it prints the `API:` line, then one error line, and exits with status 1:

```text
API:       http://host.docker.internal:6234/api/v1
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id f0ec24b6-ab20-4857-98bd-fe12f20f5b8d)
```

Without `STOW_API_KEY` it prints one line and exits with status 2:

```text
Configuration error: STOW_API_KEY is not set. Create a key in the Stow Cards console (Administration, API Keys) and export it as STOW_API_KEY.
```

## Files

| File | What it is |
|---|---|
| `src/main/java/cards/stow/example/StowClient.java` | The reusable client and its request and response records |
| `src/main/java/cards/stow/example/StowApiException.java` | The error thrown when a call fails |
| `src/main/java/cards/stow/example/Demo.java` | The runnable flow above |

To use the client in your own code, copy the first two files:

```java
StowClient stow = StowClient.fromEnvironment();   // or new StowClient(apiKey, baseUrl)
stow.onRetry(note -> System.out.println("[stow] " + note));   // optional: retries are silent by default
StowClient.Member member = stow.getMember(memberId);
```

## Notes

### Member ID

`memberCode` is the member's **Member ID**: the only identifier to show staff or customers.
Use `id` (a UUID) in API paths only, and never show `serialNumber`. Programs are keyed by
`_id`, members by `id`. The balance sits in `fieldValues` under a `balanceKey`: the example
uses the member's `program.balanceKey`, else that of the program it picked, else `points`,
and prints the value stored under that key with the key beside it, or `n/a` when there is
none. A `balanceKey` that is missing, not a string or empty is skipped; one made only of
spaces is used as it is. The value can arrive as a number or a numeric string.

### Idempotency

A points change is money-like, so send an `Idempotency-Key` with it: one key per logical
gesture, reused on every retry of that gesture. The example makes a UUID once for the award
and the client resends the same key on each automatic retry, so a retry after a lost response
replays the stored result instead of awarding the points twice. Keys are scoped to your
merchant, not to the endpoint, so never reuse one for a different call.

### Retries and timeouts

The client retries a failed call at most twice (3 attempts):

- **Retried:** network errors, timeouts and the statuses `408`, `429`, `500`, `502`, `503`
  and `504`, for the `GET` calls, the points `PATCH` (with the same `Idempotency-Key`) and
  enrolment. Enrolment is safe to repeat because it dedupes on `(programId, email)`: a retry
  returns the existing member with HTTP 200 and `deduped: true`, which the example reports.
- **One `409` is retried:** `IDEMPOTENCY_KEY_IN_USE`, and only when the request carries an
  `Idempotency-Key` and the attempt that got it was itself a retry. It then means the attempt
  the client stopped waiting for (after a timeout or a `503`, say) still holds the key, so the
  client waits and sends the same request with the same key, and gets that attempt's stored
  answer. On a first attempt the key can only be held by another call of yours, so that `409`
  is thrown: send the same request with the same key again shortly to get its answer.
- **Never retried:** every other `4xx`, including every other `409` (`CONFLICT`,
  `STAMP_CARD_FULL`, `REDEEM_NOT_ELIGIBLE`), and `501` and every other `5xx`.
- **Waits:** exponential backoff with full jitter (a random wait of up to 0.5 s, then up to
  1 s), or the server's `Retry-After`, as seconds (a plain decimal such as `5`, `1.5`, `.5` or
  `5.`, with no sign or exponent) or an HTTP date. A `Retry-After` over 60 s is not waited
  out: the error is thrown at once. One the client cannot read is ignored, and the normal
  backoff applies.

Before each retry the client passes a one-line note, which never contains the key, to the
hook set with `onRetry`; without one, retries are silent. The example prints each note to
standard output as a `[stow]` line. Redirects are never followed, so the key is never sent to
another host.

Each attempt, from connecting to reading the last byte of the response body, has 30 s; an
attempt still unfinished then is cancelled and counts as a timeout. A call can therefore take
up to about 90 s plus the waits between attempts.

The JDK's `HttpClient` also retries on its own, and has no per-client switch to stop it. When
a connection closes before any reply, it resends a `GET` once within the same attempt, so a
`GET` can reach the server up to 6 times; it never does this for the enrolment `POST` or the
points `PATCH`. When it cannot open a connection, it tries once more before the attempt
fails; no request has been sent at that point. The client speaks HTTP/1.1 only, so a
plain-http request to a local gateway carries no `Upgrade: h2c` header, which the gateway's
WebSocket server would otherwise take over.

### Errors

Every response uses one envelope: `{ "success": true, "data": ... }` or
`{ "success": false, "error": { "code": ..., "message": ... } }`. The client returns `data`
and turns every failure into a `StowApiException` carrying:

- `status()`: the HTTP status, or 0 when no response arrived;
- `code()`: `error.code` as received, for example `INVALID_API_KEY`, `NOT_FOUND` or
  `RATE_LIMITED`;
- `apiMessage()`: `error.message` as received, for people;
- `details()`: any other fields of the error object (of the body, for the older flat shape
  below);
- `requestId()`: the `X-Correlation-Id` response header, to quote to support. When the
  response has none, it is null and the message has no `(request id ...)` part.

The client fills in a code where the API gave none:

- `UNEXPECTED_RESPONSE`: a `2xx` answer that is not the envelope (usually a `STOW_BASE_URL`
  without `/api/v1`), or whose `data` is missing or the wrong shape: a program whose `_id`
  is missing, not a string or empty (any other string is accepted, since it only goes in a
  request body), a member whose `id` is missing, not a string, or blank, or a list where an
  object is needed. The client checks the ids so the example never sends a request with an
  empty one. Every call here needs `data`, so a `204` raises it too. So does a `2xx` body
  the client cannot decode: it sends `Accept-Encoding: identity`, so a body in any
  `Content-Encoding` other than `identity` is not read.
- `UNEXPECTED_REDIRECT`: a `3xx` answer, whatever its body, which is never followed.
- `HTTP_<status>`: an error whose `error.code` is missing or blank. When `error.message` is
  missing or blank, the message is the body's first 500 characters, trimmed, if the body is
  not JSON (a proxy's text or HTML page) or is a bare JSON string, else `Request failed with
  status <n>`. The flat shape older gateways sent, `{ "error": "<message>", "code": "<CODE>" }`,
  is read too: the message is the `error` string and the code the top-level `code`. An error
  body the client cannot decode is ignored and the status decides, so a `503` is still retried.
- `CONNECTION_ERROR` or `TIMEOUT`, with status 0: no response arrived, after the retries.

Blank means empty once the whitespace JavaScript's `trim()` removes is trimmed, which
includes no-break spaces and the byte order mark. A body is read as JSON whenever it parses
as JSON, whatever its `Content-Type`.

A missing or malformed key and a refused `STOW_BASE_URL` throw `IllegalStateException` from
the constructor. A member id passed to `getMember` or `adjustPoints` that is empty,
whitespace-only, `.` or `..` (the last two would resolve to another endpoint in the path)
throws `IllegalArgumentException` before anything is sent. The full list of
statuses and codes is in the Errors section of the API reference.

### The API key

The client sends the key only in the `X-API-Key` header. No message, log line or exception
quotes it, and `StowClient.toString()` shows only the base URL.

### Stub mode

A gateway without Apple or Google wallet credentials (typically a local one) runs in stub
mode: the whole flow still works, but wallet updates never reach a device. The member's
`apple.mode` and `google.mode` then say `"stub"` instead of `"real"`. Read those fields;
never infer the mode from the pass URL, which looks the same in both modes.
