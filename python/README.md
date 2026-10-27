# Stow Cards API example: Python

A small client for the Stow Cards REST API, using only the standard library, and a demo that runs the quickstart flow:

1. List programs and pick the first active one.
2. Enrol a member (`dev+<unix-ms>@example.com`, 50 starting points).
3. Award 10 points with an `Idempotency-Key`.
4. Read the member back and print its Member ID, balance, wallet links and wallet modes.

## Prerequisites

- Python 3.9 or later. No packages to install.
- A published program on your merchant (web console, Pass Designer). The demo skips draft, paused and archived programs.
- An API key (console: Administration > API Keys) whose role has these four permissions: `merchants.programs:view` (step 1), `merchants.members:create` (step 2), `merchants.members:edit` (the points change in step 3) and `merchants.members:view` (the read-back in step 4).

## Run

```bash
cd python  # from the root of the examples
export STOW_API_KEY="stow_replace_with_your_key"
python3 demo.py
```

`STOW_BASE_URL` defaults to production, `https://api.stow.cards/api/v1`. For a local development gateway, set `STOW_BASE_URL=http://localhost:6060/api/v1`. The client accepts plain `http://` only for `localhost`, `127.0.0.1`, `[::1]` (written exactly so: other spellings of the IPv6 loopback address, such as `[0::1]`, are refused), names ending in `.localhost` and `host.docker.internal`, and sends those calls straight to the gateway, never through an `HTTP_PROXY`, so the key is never sent unencrypted to another host. It also refuses a base URL with credentials, a query string or a fragment.

To keep the settings in a file instead:

```bash
cp .env.example .env    # then put your key in .env
set -a; . ./.env; set +a
python3 demo.py
```

The demo exits with `0` on success, `1` on an API or connection error (or when there is no active program) and `2` on a configuration error. Progress goes to stdout. An error goes to stderr as one line: `Error: <status> <CODE>: <message> (request id <id>)` when the API answered (without the request id part if the response carried no `X-Correlation-Id`), `Error: <CODE>: <message>` when no answer arrived (`CONNECTION_ERROR` or `TIMEOUT`), and `Configuration error: <message>` for a missing or unusable key or base URL.

## Sample output

From a run against a test gateway that has no wallet credentials (stub mode):

```text
Stow Cards API at http://127.0.0.1:6221/api/v1

1. Listed 2 program(s)
   Skipped "Archived Card" (status: archived)
   Using "Harbor Coffee Rewards" (6a0000000000000000000002)
2. Enrolled dev+1793004979643@example.com
3. Awarding 10 points (Idempotency-Key 357ef9d4-0cf0-4672-8631-c6a8eda1d0e1)
   Balance 50 -> 60
4. Member
   Member ID:      SZZJ6YZ63U
   Balance:        60 points
   Apple Wallet:   https://api.stow.cards/wallet/getpass/342f8be0-aa3a-4137-8ad0-6671ef942748.pkpass (mode: stub)
   Google Wallet:  https://pay.google.com/gp/v/save/STUB-342f8be0-aa3a-4137-8ad0-6671ef942748 (mode: stub)

Stub mode: this server has no credentials for that wallet, so the pass is not signed with a real certificate and updates do not reach a phone.
```

## Use the client in your code

```python
import uuid

from stow_client import StowApiError, StowClient

stow = StowClient()  # reads STOW_API_KEY and STOW_BASE_URL

program = next(p for p in stow.list_programs() if p["status"] == "active")
member = stow.enroll_member(program["_id"], "Ada", "Lovelace", "ada@example.com", initial_points=50)

try:
    stow.adjust_points(
        member["id"],
        delta=10,
        change_message="Thanks for visiting!",
        idempotency_key=str(uuid.uuid4()),  # one key per gesture; reuse it to retry this gesture
    )
except StowApiError as err:
    print(err.status, err.code, err.message, err.request_id)
```

Programs are keyed by `_id` and members by `id`. A method that takes a member id raises `ValueError` for one that is empty, whitespace-only, `.` or `..` (the last two would resolve to another endpoint in the path) before sending anything, and a member in a response whose `id` is missing, not a string, or one of those raises `StowApiError` with `UNEXPECTED_RESPONSE`. Every method returns the response's `data`, with the envelope removed. `stow.request(method, path, body, idempotency_key=..., retry=...)` reaches any other endpoint with the same error handling. It retries only `GET` by default, even when the call carries an `idempotency_key`; pass `retry=True` only for a call that is safe to repeat.

## Notes

### Idempotency

A points change is money-like, so `adjust_points` always sends an `Idempotency-Key`. Make one key per logical gesture (the demo uses a UUID) and keep it for every retry of that gesture. The client resends the same key on its own retries, and if an earlier attempt already went through, the API replays its stored response instead of applying the change twice. If your process may crash between attempts, store the key with your own record of the gesture (an order, a till transaction) and pass it again.

Keys must match `^[A-Za-z0-9_-]{8,128}$` as a whole, so the client refuses one with a trailing newline. They are scoped to your merchant, not to the endpoint, so never reuse one for a different call. A `409` with `IDEMPOTENCY_KEY_IN_USE` means an earlier request with that key is still being processed. The client waits for its own earlier attempts (see Retries); if you get this error, the key is held by another call, so send the same request with the same key again shortly to get its answer.

### Retries

The client retries at most twice, with exponential backoff and full jitter (a random wait of up to 0.5 s, then up to 1 s). When the server sends `Retry-After` (a number of seconds such as `5`, `0.5`, `.5` or `5.`, with no sign or exponent, or an HTTP date) it waits that long instead, up to 60 s; a longer wait is raised as an error at once rather than blocking, and a value it cannot read is ignored in favour of the normal backoff. It retries network errors, timeouts and the statuses `408`, `429`, `500`, `502`, `503` and `504`, and only on calls that are safe to repeat:

- `GET` requests;
- the points `PATCH`, with the same `Idempotency-Key`;
- enrolment, because the API dedupes on `(programId, email)`: a repeat returns the existing member with HTTP `200` and `"deduped": true`, which the demo reports.

One `409` is retried too: `IDEMPOTENCY_KEY_IN_USE` on a retry of a call that carries an `Idempotency-Key`. It means the client's own earlier attempt (one it stopped waiting for, say after a timeout or a `503`) still holds the key, so the client backs off and sends the same request with the same key, and receives that attempt's stored answer. The same code on a first attempt means another call holds the key, so it is raised, not retried. Every other `4xx`, including other `409`s such as `STAMP_CARD_FULL` or `CONFLICT`, is never retried, and neither is `501` or any other `5xx` not listed above. Redirects are never followed. Each retry is logged through the standard `logging` module (logger `stow_client`), with the request id when the response has one, and the demo prints those lines to stdout:

```text
   (retry) PATCH /merchants/me/members/408e2e24-31f7-4ad2-8129-ee997f1b4f87/points -> 503 SERVICE_UNAVAILABLE; retry 1 of 2 in 0.3 s (request id c19cee32-2cde-4698-a74e-6e75928a708e)
```

Each attempt is cut off 30 s after it starts (`StowClient(timeout=...)`, at most one day), covering the connection, TLS, the request and the whole response body, so a response that stalls or trickles in cannot hold it open. When the host name has several addresses, they share that time: each is tried for an equal part of what is left (at least 2 s, if that much remains), and none once it has run out. Only the DNS lookup is left to the system resolver's own limits; if it outlasts the timeout, the attempt fails with `TIMEOUT` as soon as the lookup returns. The standard library never resends a request by itself, so a call makes at most three requests. `max_retries` sets the retry count. The gateway rate-limits per client IP address (1000 requests per 15 minutes by default in production), shared with all other traffic from that address, so use a CSV import job rather than a loop of enrolments for bulk onboarding.

### Errors

Every failure the client raises is a `StowError`:

| Class | When | Fields |
|---|---|---|
| `StowApiError` | The API answered with an error, or with something that is not an API response: `UNEXPECTED_RESPONSE` (a `2xx` without the `{"success": true, ...}` envelope or the expected `data`, or a `2xx` body that cannot be decoded) or `UNEXPECTED_REDIRECT` (a `3xx`, which the client never follows). | `status`, `code`, `message`, `details` (any other fields of the error object), `request_id` (the `X-Correlation-Id` response header), `body` |
| `StowConnectionError` | No HTTP response: DNS, TLS, or a refused or reset connection. | |
| `StowTimeoutError` | An attempt timed out. A subclass of `StowConnectionError`. | |
| `StowConfigError` | `STOW_API_KEY` is missing or contains a space, line break, control or non-ASCII character, `STOW_BASE_URL` is unsafe, or `timeout` or `max_retries` is out of range. | |

Branch on `code` (`INVALID_API_KEY`, `FORBIDDEN`, `NOT_FOUND`, `BILLING_SUBSCRIPTION_REQUIRED`, `STAMP_CARD_FULL`, `RATE_LIMITED` and so on), show `message` to people, and quote `request_id` when you contact support. An error body without a code, or with an empty or whitespace-only one, gives `HTTP_<status>`. Without a message (or with an empty one), a body that is not JSON, or is a bare JSON string, gives its trimmed text (the first 500 characters); any other body gives `Request failed with status <n>`. A body counts as JSON when it parses as JSON, whatever its `Content-Type`. The older flat shape `{"error": "<message>", "code": "<CODE>"}` is read too: the string is the message and the top-level `code`, when there is one, is the code. An error body that cannot be decoded counts as empty, so the status still decides: a `503` stays retryable. An invalid key ends the demo with one line:

```text
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id 472737a3-f275-4951-bb0d-132c225e0292)
```

The client never prints or logs the API key. `repr()` and `vars()` show it as `<hidden>`, pickling the client raises `TypeError`, and a key with a space, line break, control or non-ASCII character is refused up front with a message that does not repeat it. Surrounding whitespace is trimmed first: the characters JavaScript's `trim()` removes, the same as the Node.js SDK, so a no-break space picked up when copying from a web page is dropped. The client does not follow redirects, so the key is never forwarded to another host.

### Stub mode

A server without Apple or Google Wallet credentials still runs the whole flow, but the passes it issues are placeholders and updates do not reach a phone. The member's `apple.mode` and `google.mode` then say `"stub"` instead of `"real"`. Read those fields: the pass URL looks the same in both modes, so it tells you nothing. A local development gateway usually runs in stub mode.

### Member identity

`memberCode` is the member's **Member ID**, the only member identifier to show to staff or customers. Use `id` (a UUID) in API paths, and treat `serialNumber` as internal wallet plumbing that is never displayed. The balance sits in `fieldValues` and can arrive as a numeric string such as `"0"`. The demo reads it under the member's `program.balanceKey`, else the listed program's `balanceKey`, else `points`, and prints `n/a` when `fieldValues` has no entry under that key.

## Files

- `stow_client.py`: the reusable client.
- `demo.py`: the runnable flow.
- `.env.example`: the environment variables the demo reads.
