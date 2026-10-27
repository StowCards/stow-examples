# Ruby example

The Stow Cards loyalty loop in Ruby: list programs, enroll a member, award
points and read the member back. It uses the standard library only
(`net/http`, `json`, `securerandom`, `uri`), so there are no gems to install.

## Prerequisites

- Ruby 3.1 or later (`ruby -v`). macOS ships Ruby 2.6, which is too old:
  install a current Ruby or use the Docker command below.
- An API key from the Stow Cards console (Administration, API Keys) whose role
  has these four permissions:
  - `merchants.programs:view` (list programs)
  - `merchants.members:create` (enroll the member)
  - `merchants.members:edit` (the points change)
  - `merchants.members:view` (the read-back)
- At least one active (published) program on the merchant the key belongs to.

## Run

```bash
export STOW_API_KEY="stow_replace_with_your_key"
# Optional; this is the default:
export STOW_BASE_URL="https://api.stow.cards/api/v1"
ruby demo.rb
```

Without a local Ruby, from this folder:

```bash
docker run --rm -v "$PWD":/app -w /app -e STOW_API_KEY -e STOW_BASE_URL ruby:3.4 ruby demo.rb
```

Inside the container, a gateway running on your machine is
`host.docker.internal`, not `localhost`.

Each run enrolls a new member, `dev+<unix-ms>@example.com`, and issues wallet
passes for it, so point the demo at a merchant you use for testing. The base
URL must use https; plain http is accepted only for `localhost`, `127.0.0.1`,
`[::1]` (written exactly so; other spellings of the IPv6 loopback address are
refused), a name ending in `.localhost` and `host.docker.internal`. A base URL
with credentials, a query, a fragment or an invalid port (an empty one such as
`localhost:` included) is refused, and trailing slashes are dropped.

## Sample output

From a run against a mock gateway that fails the first points attempt with a
`503`:

```text
Stow Cards API at http://host.docker.internal:6223/api/v1
1. Programs: 2 found, using "Harbor Coffee Rewards" (6a0000000000000000000002)
2. Enrolled dev+1793004858243@example.com
   retry 1/2 in 0.30 s after 503 SERVICE_UNAVAILABLE
3. Awarded 10 points: 50 -> 60 (Idempotency-Key 690e95aa-a5ec-431a-b6e6-376ee68da08a)
4. Member read back
   Member ID:     4VYKRYY2BC
   Balance:       60 points
   Apple Wallet:  https://api.stow.cards/wallet/getpass/2287f89b-9d9f-4999-9cd5-4eff7fb365ba.pkpass (mode: stub)
   Google Wallet: https://pay.google.com/gp/v/save/STUB-2287f89b-9d9f-4999-9cd5-4eff7fb365ba (mode: stub)
   Stub mode: the server has no wallet credentials for this pass, so updates do not reach a device.
```

Progress goes to stdout. A failure prints one line to stderr and exits with
status 1 for an API or connection error, or 2 for a configuration error:

```text
Error: 401 INVALID_API_KEY: Invalid or expired API key. (request id 169171ea-e0be-426b-b9cc-988f33e9ff2d)
```

```text
Configuration error: STOW_API_KEY is not set. Create a key in the Stow Cards console (Administration, API Keys) and export it as STOW_API_KEY.
```

When no response arrived, the line is `Error: <CODE>: <message>`, for example
`Error: TIMEOUT: The attempt did not finish within 30 s.`

## Files

- `stow_client.rb`: `StowClient`, a small reusable client (configuration,
  headers, envelope unwrapping, retries, typed errors).
- `demo.rb`: the four-step flow above.

## Use the client in your own code

```ruby
require "securerandom"
require_relative "stow_client"

stow = StowClient.from_env # or StowClient.new(api_key: "stow_...")

program = stow.list_programs.find { |p| p["status"] == "active" }
member = stow.enroll_member(program_id: program["_id"], first_name: "Ada",
                            last_name: "Lovelace", email: "ada@example.com")
stow.adjust_points(member["id"], delta: 10, change_message: "Welcome!",
                                 idempotency_key: SecureRandom.uuid)
```

Programs are raw records keyed by `_id`; members use `id`. Use a member's `id`
in API paths only. The identifier to show staff and customers is `memberCode`,
labelled "Member ID"; never show `id` or `serialNumber` as the member's ID.
The balance sits in `fieldValues` under a `balanceKey`, and can arrive as a
numeric string such as `"0"`. The demo takes the key from the member's
`program.balanceKey`, then the program it listed, then `"points"`, and prints
`n/a` when `fieldValues` has no entry under that key.

The client checks the identifiers the flow depends on: `list_programs` needs
every program to have a non-empty string `_id`, and `enroll_member` and
`get_member` need a member whose `id` is a string that is not empty or only
whitespace. Anything else raises `StowApiError` with code
`UNEXPECTED_RESPONSE`, so no request goes out with an empty id. Before sending
anything, `enroll_member` raises `ArgumentError` for an empty `program_id`,
and `get_member` and `adjust_points` raise it for a `member_id` that is empty,
only whitespace, `.` or `..` (the last two would resolve to another endpoint in
the path).

`StowClient.new` also takes `timeout:` (a positive number of seconds each
attempt may take, default 30), `max_retries:` (an Integer of 0 or more,
default 2) and `on_retry:` (a callable that receives the retry number, the
maximum, the delay in seconds and the reason). Other values raise
`ArgumentError`.

The key is trimmed of surrounding whitespace, as the Node.js SDK trims it
(Unicode spaces such as a no-break space included), and must then be visible
ASCII only; a key with a line break, a space inside or a character such as a
curly quote raises `StowConfigError`, whose message never contains the key.
The client keeps the key out of its own output: `inspect` shows only the base
URL, `YAML.dump` leaves the key out and `Marshal.dump` raises.

## Idempotency

`adjust_points` always sends an `Idempotency-Key` (a UUID unless you pass
`idempotency_key:`, which must be 8 to 128 characters of `A-Z`, `a-z`, `0-9`,
`_` and `-`). Make one key per gesture, such as one award at the till, and
pass the same key again if you retry that gesture yourself, for example after
a crash. The client resends the same key on its own retries, so the server
applies the change once and replays the stored response. Keys are scoped to
your merchant, not to the endpoint, so never reuse one for a different call.

A `409` with code `IDEMPOTENCY_KEY_IN_USE` means an earlier request with that
key is still being processed. When it answers one of the client's own retries
(the earlier attempt timed out but is still running), the client waits and
tries again with the same key to get the stored answer. When it answers a
first attempt, another call of yours holds the key, so the client raises it:
send the same call with the same key again shortly.

Enrolment needs no key. It dedupes on program and email, so a repeat returns
the existing member with `deduped: true`; treat that as success. You can see
`deduped: true` on a first run too, when the client retried an enrolment whose
first attempt had already succeeded.

## Retries

The client retries network errors, timeouts and the statuses `408`, `429`,
`500`, `502`, `503` and `504`, at most twice, for the calls that are safe to
repeat: GET requests, the points change (with the same `Idempotency-Key`) and
enrolment (which dedupes). A call you send through `request` is retried only
when it is a GET or you pass `retryable: true`; any other call, including a
POST with an `Idempotency-Key`, gets a single attempt. Pass `retryable: true`
only for a call that is safe to repeat. Net::HTTP's own silent resend is switched
off (`max_retries: 0`), so a call sends at most three requests.

One `409` is retried: `IDEMPOTENCY_KEY_IN_USE`, and only on a request that
carries an `Idempotency-Key` when the attempt that got it was itself a retry.
A `409` on a first attempt is never retried, and neither is any other `4xx`,
nor `501` or another `5xx` outside the list above.

Waits use exponential backoff with full jitter: a random delay below a
ceiling that starts at 0.5 s and doubles each time, up to 8 s. A `Retry-After`
header, in seconds (whole or decimal, such as `5`, `5.0`, `5.` or `.5`, with
no sign or exponent) or as an HTTP date, replaces that delay
when it asks for 60 s or less; a longer one (the rate-limit window is 15
minutes) is raised at once so your code can decide what to do. A
`Retry-After` the client cannot read is ignored and the normal backoff
applies.

Each attempt is limited to 30 s (the `timeout:`), from opening the connection
to reading the last byte of the response body, so a server that stalls or
sends its answer slowly cannot hold an attempt open longer. On Ruby 3.3 and
later the limit includes the DNS lookup. On Ruby 3.1 and 3.2 it does not: the
lookup inside `TCPSocket.open` cannot be interrupted there, so if the system
resolver hangs, the attempt fails with `TIMEOUT` only once the lookup returns,
after the resolver's own limits.

## Errors

Every error the client raises inherits from `StowError`:

| Class | When | Carries |
|---|---|---|
| `StowConfigError` | `STOW_API_KEY` missing or not visible ASCII, or an unusable base URL | message |
| `StowApiError` | the API answered with an error, or with something that is not an API answer | `status`, `code`, `api_message`, `details`, `request_id`, `retry_after`, `body` |
| `StowConnectionError` | no HTTP response (DNS, refused or reset connection, TLS) | `code` (`CONNECTION_ERROR`), message |
| `StowTimeoutError` | an attempt timed out (a `StowConnectionError`) | `code` (`TIMEOUT`), message |

On a `StowApiError`, branch on `code` (`INVALID_API_KEY`, `NOT_FOUND`,
`STAMP_CARD_FULL`, ...) and show `api_message` to people. `details` holds the
other fields of the API's `error` object, such as `current` and `goal` on
`REDEEM_NOT_ELIGIBLE`. `request_id` comes from the `X-Correlation-Id` response
header; quote it when you contact support. Without that header `request_id`
is `nil` and the error's message has no request id. An `error.code` that is
missing, empty or only whitespace gives `HTTP_<status>`. The older flat shape
`{"error": "<message>", "code": "<CODE>"}` is read as the SDK reads it: the
message is that string and the code is the top-level `code`. When the message
is missing, empty or only whitespace, it is the body's trimmed text (its first
500 characters) for a body that is text or a JSON string, else
`Request failed with status <n>`. Whitespace here includes the Unicode spaces
that JavaScript's `trim()` removes, such as U+00A0 and U+FEFF. A body is read
as JSON whenever it parses as JSON, whatever its `Content-Type`, so a
`text/plain` body of `"Service down"` gives the message `Service down`.

The exception's `message` is always one line (`api_message` keeps the text as
the API sent it): each run of whitespace or line breaks, U+0085, U+2028 and
U+2029 included, becomes one space.

The client also raises `StowApiError` with its own codes:

- `UNEXPECTED_REDIRECT`: a `3xx`, whatever its body. Redirects are never
  followed, so the key is never sent to another host.
- `UNEXPECTED_RESPONSE`: a `2xx` that is not the API's `{"success": true, ...}`
  envelope (a proxy page, or a base URL without `/api/v1`), a body that cannot
  be decoded, or data that is not what the call returns (see the identifier
  checks above). A `204` is a success with no data: `request` returns `nil`,
  and a call that needs data raises this code.

The client asks for an uncompressed body (`Accept-Encoding: identity`), so a
body sent under any other `Content-Encoding` cannot be decoded. The status
decides first: on a `2xx` such a body is `UNEXPECTED_RESPONSE`, while an error
status keeps its usual handling with the message
`Request failed with status <n>` (a `503` is still retried).

```ruby
begin
  stow.adjust_points(member_id, delta: 1, idempotency_key: key)
rescue StowApiError => e
  raise unless e.code == "STAMP_CARD_FULL"

  puts "Card is full: redeem the reward first."
end
```

## Stub mode

A server without Apple or Google Wallet credentials (typical for a local
development gateway) runs in stub mode. The flow still works end to end, but
wallet updates are not delivered to a device, and the member's `apple.mode` /
`google.mode` say `"stub"` instead of `"real"`. Read those fields; never infer
the mode from the pass URL, which is the same in both modes.
