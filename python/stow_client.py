"""Small client for the Stow Cards public REST API (Python 3.9+, standard library only).

It sends the API key, unwraps the {"success": true, "data": ...} envelope,
raises StowApiError on failure and retries the calls that are safe to repeat.
"""
from __future__ import annotations

import email.utils
import gzip
import http.client
import ipaddress
import json
import logging
import os
import random
import re
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from datetime import datetime, timezone
from email.message import Message
from typing import IO, Any, Callable, Mapping, Optional

__all__ = [
    "DEFAULT_BASE_URL",
    "StowApiError",
    "StowClient",
    "StowConfigError",
    "StowConnectionError",
    "StowError",
    "StowTimeoutError",
]

DEFAULT_BASE_URL = "https://api.stow.cards/api/v1"
USER_AGENT = "stowcards-example-python/1.0"
DEFAULT_TIMEOUT = 30.0  # seconds, for a whole attempt, response body included
MAX_TIMEOUT = 86400.0  # one day; far larger values overflow the socket and timer APIs
DEFAULT_MAX_RETRIES = 2
INITIAL_BACKOFF = 0.5  # seconds
MAX_BACKOFF = 8.0  # seconds
MAX_RETRY_AFTER = 60.0  # longest Retry-After the client sleeps through
RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

_VISIBLE_ASCII = re.compile(r"[\x21-\x7e]+")
_IDEMPOTENCY_KEY = re.compile(r"[A-Za-z0-9_-]{8,128}")
_DELAY_SECONDS = re.compile(r"[0-9]+(?:\.[0-9]*)?|\.[0-9]+")
_HOST_LABEL = re.compile(r"[a-z0-9_-]{1,63}")
_PLAIN_HTTP_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]", "host.docker.internal"})
# The whitespace JavaScript's trim() removes (str.strip() differs: it also takes U+001C-U+001F and
# U+0085 but not U+FEFF), so a pasted key is trimmed exactly as the Node SDK trims it.
_SPACE = "\t\n\v\f\r \u00a0\u1680" + "".join(map(chr, range(0x2000, 0x200B))) + "\u2028\u2029\u202f\u205f\u3000\ufeff"

log = logging.getLogger("stow_client")


class StowError(Exception):
    """Base class of every error this client raises."""


class StowConfigError(StowError):
    """The client is misconfigured: no API key, an unusable key, or an unsafe base URL."""


class StowConnectionError(StowError):
    """The request got no HTTP response (DNS, TLS, refused or reset connection)."""

    code = "CONNECTION_ERROR"


class StowTimeoutError(StowConnectionError):
    """The attempt did not finish within the timeout."""

    code = "TIMEOUT"


class StowApiError(StowError):
    """The API answered with an error, or with something that is not an API response.

    Branch on ``code`` (for example ``NOT_FOUND`` or ``STAMP_CARD_FULL``),
    show ``message`` to people and quote ``request_id`` to support.
    ``details`` holds any other fields of the error object.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Optional[dict[str, Any]] = None,
        request_id: Optional[str] = None,
        body: Any = None,
    ) -> None:
        self.status = status
        self.code = code
        self.message = message
        self.details: dict[str, Any] = details or {}
        self.request_id = request_id
        self.body = body
        text = f"{status} {code}: {message}"
        if request_id:
            text += f" (request id {request_id})"
        super().__init__(text)


class _Secret:
    """Holds the API key so that repr(), vars() and pickle never show it."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def __repr__(self) -> str:
        return "<hidden>"

    def __reduce__(self) -> Any:
        raise TypeError("The API key cannot be pickled.")

    def __copy__(self) -> _Secret:
        return self

    def __deepcopy__(self, memo: dict[int, Any]) -> _Secret:
        return self

    def reveal(self) -> str:
        return self._value


class StowClient:
    """Client for the Stow Cards API.

    The API key and base URL default to the STOW_API_KEY and STOW_BASE_URL
    environment variables.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("STOW_API_KEY", "")
        if not isinstance(key, str):
            raise StowConfigError("The API key must be a string.")
        key = key.strip(_SPACE)
        if not key:
            raise StowConfigError(
                "STOW_API_KEY is not set. Create an API key in the Stow Cards console "
                "(Administration > API Keys) and export it as STOW_API_KEY."
            )
        if not _VISIBLE_ASCII.fullmatch(key):
            raise StowConfigError(
                "STOW_API_KEY contains a space, a line break, a control character or a non-ASCII character. "
                "Copy the key from the console again."
            )
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or max_retries < 0:
            raise StowConfigError("max_retries must be a non-negative integer.")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= MAX_TIMEOUT:
            raise StowConfigError(f"timeout must be a positive number of seconds, at most {MAX_TIMEOUT:g}.")
        self._api_key = _Secret(key)
        env_url = os.environ.get("STOW_BASE_URL", "").strip(_SPACE)
        self.base_url = _check_base_url(base_url or env_url or DEFAULT_BASE_URL)
        self.timeout = float(timeout)
        self.max_retries = max_retries
        self._ssl_context = ssl.create_default_context()
        # Plain http is allowed only for a local gateway, so it never goes through an HTTP_PROXY.
        self._direct = self.base_url.lower().startswith("http:")

    def __repr__(self) -> str:
        return f"StowClient(base_url={self.base_url!r})"

    # The four calls of the quickstart flow.

    def list_programs(self) -> list[dict[str, Any]]:
        """The merchant's programs. Programs are keyed by ``_id``, not ``id``."""
        return self._request("GET", "/merchants/me/programs", expect=_is_program_list, what="program list")

    def enroll_member(
        self,
        program_id: str,
        first_name: str,
        last_name: str,
        email: str,
        *,
        phone: Optional[str] = None,
        initial_points: Optional[int] = None,
    ) -> dict[str, Any]:
        """Enrol a customer. If the email is already in the program, the API
        returns that member with ``deduped: true`` and creates nothing."""
        body: dict[str, Any] = {
            "programId": program_id,
            "firstName": first_name,
            "lastName": last_name,
            "email": email,
        }
        if phone is not None:
            body["phone"] = phone
        if initial_points is not None:
            body["initialPoints"] = initial_points
        # Safe to retry: enrolment dedupes on (programId, email).
        return self._request("POST", "/merchants/me/members", body, retry=True, expect=_is_member, what="member")

    def adjust_points(
        self,
        member_id: str,
        *,
        delta: Optional[int] = None,
        value: Optional[int] = None,
        change_message: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        """Change a member's balance by ``delta`` or set it to ``value``.

        Pass one ``idempotency_key`` per gesture and the same key when you
        retry that gesture yourself. Without one, the client makes a UUID
        and reuses it across its own retries.
        """
        if (delta is None) == (value is None):
            raise ValueError("Pass exactly one of delta or value.")
        body: dict[str, Any] = {"delta": delta} if delta is not None else {"value": value}
        if change_message:
            body["changeMessage"] = change_message
        # Safe to retry: every attempt carries the same Idempotency-Key.
        return self._request(
            "PATCH",
            f"/merchants/me/members/{_segment(member_id)}/points",
            body,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
            retry=True,
            expect=_is_object,
            what="points result",
        )

    def get_member(self, member_id: str) -> dict[str, Any]:
        """The full member, with a ``program`` snapshot. ``member_id`` is the
        member's ``id`` (UUID), not its ``memberCode``."""
        return self._request("GET", f"/merchants/me/members/{_segment(member_id)}", expect=_is_member, what="member")

    # Transport.

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
        retry: Optional[bool] = None,
    ) -> Any:
        """Send one API call and return the envelope's ``data`` (None for a 204).

        By default only GET is retried. Pass ``retry=True`` only for a call
        that is safe to repeat, such as one the API dedupes or one that
        carries an ``idempotency_key``.
        """
        return self._request(method, path, body, idempotency_key=idempotency_key, retry=retry)

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Mapping[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
        retry: Optional[bool] = None,
        expect: Optional[Callable[[Any], bool]] = None,
        what: str = "data",
    ) -> Any:
        if idempotency_key is not None and not (
            isinstance(idempotency_key, str) and _IDEMPOTENCY_KEY.fullmatch(idempotency_key)
        ):
            raise ValueError("idempotency_key must be 8 to 128 characters of [A-Za-z0-9_-].")
        if retry is None:
            retry = method == "GET"

        url = self.base_url + path
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "X-API-Key": self._api_key.reveal(),
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key is not None:
            headers["Idempotency-Key"] = idempotency_key
        label = f"{method} {path}"

        attempt = 0
        while True:
            try:
                status, response_headers, raw = self._send(method, url, data, headers, label)
            except StowConnectionError as exc:
                if not retry or attempt >= self.max_retries:
                    raise
                delay = _backoff(attempt)
                log.info("%s; retry %d of %d in %.1f s", exc, attempt + 1, self.max_retries, delay)
            else:
                request_id = response_headers.get("X-Correlation-Id")
                if 200 <= status < 300:
                    result = _unwrap(status, raw, response_headers, request_id)
                    if expect is not None and not expect(result):
                        raise StowApiError(
                            status,
                            "UNEXPECTED_RESPONSE",
                            f"The response does not contain the expected {what}.",
                            request_id=request_id,
                            body=result,
                        )
                    return result
                error = _response_error(status, raw, response_headers, request_id)
                wait = _retry_after(response_headers)
                can_retry = (
                    retry
                    and attempt < self.max_retries
                    and _should_retry(status, error.code, idempotency_key is not None, attempt)
                    and (wait is None or wait <= MAX_RETRY_AFTER)
                )
                if not can_retry:
                    raise error
                delay = wait if wait is not None else _backoff(attempt)
                log.info(
                    "%s -> %d %s; retry %d of %d in %.1f s%s",
                    label, status, error.code, attempt + 1, self.max_retries, delay,
                    f" (request id {request_id})" if request_id else "",
                )
            time.sleep(delay)
            attempt += 1

    def _send(
        self, method: str, url: str, data: Optional[bytes], headers: dict[str, str], label: str
    ) -> tuple[int, Message, bytes]:
        attempt = _Attempt(self.timeout)
        handlers: list[Any] = [_RefuseRedirects, _HTTPHandler(attempt), _HTTPSHandler(attempt, self._ssl_context)]
        if self._direct:
            handlers.append(urllib.request.ProxyHandler({}))
        opener = urllib.request.build_opener(*handlers)
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            try:
                response = opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as exc:
                response = exc  # a non-2xx answer still has a status, headers and body
            with response:
                status = response.getcode()
                response_headers = response.headers
                raw = response.read()
        except (OSError, http.client.HTTPException) as exc:
            if attempt.expired or _is_timeout(exc):
                raise StowTimeoutError(f"{label} timed out after {self.timeout:g} s") from exc
            reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            raise StowConnectionError(
                f"{label}: could not reach the API ({str(reason) or type(reason).__name__})"
            ) from exc
        finally:
            attempt.cancel()
        if attempt.expired:  # the deadline cut the body short
            raise StowTimeoutError(f"{label} timed out after {self.timeout:g} s")
        return status, response_headers, raw


class _Attempt:
    """One attempt's deadline. When it passes, the connection is shut down, so a
    response that trickles in or stalls cannot hold the attempt open."""

    def __init__(self, seconds: float) -> None:
        self.expired = False
        self._deadline = time.monotonic() + seconds
        self._sockets: list[socket.socket] = []
        self._lock = threading.Lock()
        self._timer = threading.Timer(seconds, self._expire)
        self._timer.daemon = True
        self._timer.start()

    def watch(self, sock: socket.socket) -> None:
        with self._lock:
            self._sockets.append(sock)
            if self.expired:
                _shutdown(sock)

    def left(self) -> float:
        return self._deadline - time.monotonic()

    def cancel(self) -> None:
        self._timer.cancel()

    def _expire(self) -> None:
        with self._lock:
            self.expired = True
            for sock in self._sockets:
                _shutdown(sock)


def _shutdown(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass  # already closed


class _Watched:
    """Hands each new connection's socket to the attempt that owns it as soon
    as it connects, so the deadline also covers a proxy tunnel and TLS."""

    def __init__(self, host: str, *, attempt: _Attempt, **kwargs: Any) -> None:
        super().__init__(host, **kwargs)  # type: ignore[call-arg]
        self._attempt = attempt
        self._create_connection = self._connect_watched

    def _connect_watched(
        self, address: tuple[str, int], timeout: Any = None, source_address: Any = None
    ) -> socket.socket:
        # socket.create_connection, except that the addresses share the time left in
        # the attempt (not one full timeout each) and none is tried once it has passed.
        # Each gets an equal part, at least 2 s, so a silent first address (say, broken
        # IPv6) cannot use up the attempt before a working one is tried.
        error: OSError = OSError("getaddrinfo returns an empty list")
        addresses = socket.getaddrinfo(*address, 0, socket.SOCK_STREAM)
        for index, (family, kind, proto, _, addr) in enumerate(addresses):
            left = self._attempt.left()
            if left <= 0:
                error = socket.timeout("timed out")
                break
            sock = socket.socket(family, kind, proto)
            self._attempt.watch(sock)
            try:
                sock.settimeout(max(left / (len(addresses) - index), min(left, 2.0)))
                if source_address:
                    sock.bind(source_address)
                sock.connect(addr)
                sock.settimeout(timeout)  # from here the attempt's timer enforces the deadline
                return sock
            except OSError as exc:
                error = exc
                sock.close()
        raise error


class _HTTPConnection(_Watched, http.client.HTTPConnection):
    pass


class _HTTPSConnection(_Watched, http.client.HTTPSConnection):
    def connect(self) -> None:
        # HTTPSConnection.connect, with the TLS socket watched before its handshake.
        http.client.HTTPConnection.connect(self)
        self.sock = self._context.wrap_socket(  # type: ignore[attr-defined]
            self.sock, server_hostname=self._tunnel_host or self.host, do_handshake_on_connect=False
        )
        self._attempt.watch(self.sock)
        self.sock.do_handshake()


class _HTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, attempt: _Attempt) -> None:
        super().__init__()
        self._attempt = attempt

    def http_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_HTTPConnection, req, attempt=self._attempt)


class _HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, attempt: _Attempt, context: ssl.SSLContext) -> None:
        super().__init__(context=context)
        self._attempt = attempt
        self._ssl_context = context

    def https_open(self, req: urllib.request.Request) -> http.client.HTTPResponse:
        return self.do_open(_HTTPSConnection, req, context=self._ssl_context, attempt=self._attempt)


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirects, so the API key is never forwarded to another host."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: IO[bytes],
        code: int,
        msg: str,
        headers: Message,
        newurl: str,
    ) -> Optional[urllib.request.Request]:
        return None


def _check_base_url(raw: Any) -> str:
    if not isinstance(raw, str):
        raise StowConfigError("STOW_BASE_URL must be a string.")
    url = raw.strip(_SPACE).rstrip("/")
    example = "a full URL such as https://api.stow.cards/api/v1"
    if not _VISIBLE_ASCII.fullmatch(url):
        raise StowConfigError(f"STOW_BASE_URL must be {example}, with no spaces or non-ASCII characters.")
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        raise StowConfigError(f"STOW_BASE_URL must be {example}.") from None
    if parts.scheme not in ("https", "http") or not parts.netloc:
        raise StowConfigError(f"STOW_BASE_URL must be {example}.")
    if "@" in parts.netloc or "?" in url or "#" in url:
        raise StowConfigError("STOW_BASE_URL must not contain credentials, a query string or a fragment.")
    if parts.netloc.startswith("["):
        literal, _, rest = parts.netloc[1:].partition("]")
        if rest and not rest.startswith(":"):
            raise StowConfigError("STOW_BASE_URL has an invalid port.")
        sep, port = rest[:1], rest[1:]
        try:
            ipaddress.IPv6Address(literal)
        except ValueError:
            raise StowConfigError(f"STOW_BASE_URL must be {example}.") from None
        host = f"[{literal}]"  # as written: only the literal [::1] gets plain http, not [0::1] and the like
    else:
        host, sep, port = parts.netloc.lower().partition(":")
        name = host[:-1] if host.endswith(".") else host
        if len(name) > 253 or not all(_HOST_LABEL.fullmatch(label) for label in name.split(".")):
            raise StowConfigError(f"STOW_BASE_URL must be {example}.")
    if sep and not (port.isdigit() and 0 < int(port) < 65536):
        raise StowConfigError("STOW_BASE_URL has an invalid port.")
    if parts.scheme == "http" and host not in _PLAIN_HTTP_HOSTS and not host.endswith(".localhost"):
        raise StowConfigError(
            "STOW_BASE_URL must use https:// so the API key is never sent unencrypted (plain http:// is "
            "accepted only for localhost, 127.0.0.1, [::1], *.localhost and host.docker.internal)."
        )
    return url


def _is_id(value: Any) -> bool:
    # "." and ".." would resolve to another endpoint once placed in the path.
    return isinstance(value, str) and value.strip(_SPACE) not in ("", ".", "..")


def _segment(value: str) -> str:
    if not _is_id(value):
        raise ValueError('member_id must be a string that is not empty, whitespace, "." or "..".')
    return urllib.parse.quote(value, safe="")


def _is_object(data: Any) -> bool:
    return isinstance(data, dict)


def _is_member(data: Any) -> bool:
    return isinstance(data, dict) and _is_id(data.get("id"))


def _is_program_list(data: Any) -> bool:
    return isinstance(data, list) and all(
        isinstance(item, dict) and isinstance(item.get("_id"), str) and bool(item["_id"]) for item in data
    )


def _is_timeout(exc: BaseException) -> bool:
    return isinstance(exc, socket.timeout) or isinstance(getattr(exc, "reason", None), socket.timeout)


class _Undecodable(Exception):
    """The body uses a content encoding that is unknown or corrupt."""


def _parse_body(raw: bytes, headers: Message) -> Any:
    """The body as parsed JSON (whatever its Content-Type), else as text; None when it is empty."""
    encoding = (headers.get("Content-Encoding") or "identity").strip().lower()
    try:
        if encoding in ("gzip", "x-gzip"):
            raw = gzip.decompress(raw)
        elif encoding == "deflate":
            raw = zlib.decompress(raw)
        elif encoding != "identity":
            raise _Undecodable(encoding)
    except _Undecodable:
        raise
    except Exception as exc:  # whatever the decoder raises for corrupt input
        raise _Undecodable(encoding) from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="replace")  # text, never JSON
    if not text.strip(_SPACE):
        return None
    try:
        return json.loads(text, parse_constant=_not_json)
    except (ValueError, RecursionError):
        return text


def _not_json(name: str) -> Any:
    raise ValueError(f"{name} is not JSON")  # json.loads would otherwise accept NaN and Infinity


def _unwrap(status: int, raw: bytes, headers: Message, request_id: Optional[str]) -> Any:
    """The ``data`` of a 2xx answer, or StowApiError(UNEXPECTED_RESPONSE)."""
    if status == 204:
        return None
    message = (
        "The response is not a Stow Cards API response. Check that STOW_BASE_URL ends in /api/v1 "
        "and that no proxy rewrites the answer."
    )
    try:
        payload = _parse_body(raw, headers)
    except _Undecodable:
        raise StowApiError(status, "UNEXPECTED_RESPONSE", message, request_id=request_id) from None
    if not (isinstance(payload, dict) and payload.get("success") is True):
        raise StowApiError(status, "UNEXPECTED_RESPONSE", message, request_id=request_id, body=payload)
    return payload.get("data")


def _response_error(status: int, raw: bytes, headers: Message, request_id: Optional[str]) -> StowApiError:
    if 300 <= status < 400:
        return StowApiError(
            status,
            "UNEXPECTED_REDIRECT",
            "The server answered with a redirect, which this client does not follow. Check STOW_BASE_URL.",
            request_id=request_id,
        )
    try:
        payload = _parse_body(raw, headers)
    except _Undecodable:
        payload = None  # the status still decides: a 503 stays a retryable 503
    error = _error_object(payload)
    code = error.get("code")
    code = code if isinstance(code, str) and code.strip(_SPACE) else f"HTTP_{status}"
    message = error.get("message")
    if not (isinstance(message, str) and message.strip(_SPACE)):
        # A body that is not JSON, or is a bare JSON string; any other JSON gives the default.
        text = payload.strip(_SPACE) if isinstance(payload, str) else ""
        message = text[:500] or f"Request failed with status {status}"
    details = {k: v for k, v in error.items() if k not in ("code", "message")}
    return StowApiError(status, code, message, details=details, request_id=request_id, body=payload)


def _error_object(payload: Any) -> dict[str, Any]:
    """The documented {"error": {"code", "message"}} object, or the flat
    {"error": message, "code": ...} that older gateways sent."""
    if not isinstance(payload, dict):
        return {}
    error = payload.get("error")
    if isinstance(error, dict):
        return error
    if isinstance(error, str):
        fields = {k: v for k, v in payload.items() if k not in ("error", "success")}
        return {**fields, "message": error}
    return {}


def _should_retry(status: int, code: str, has_idempotency_key: bool, attempt: int) -> bool:
    if status == 409:
        # On a retry of a keyed call, IDEMPOTENCY_KEY_IN_USE means our own earlier
        # attempt still holds the key; waiting lets the next attempt get its stored
        # answer. Any other 409, or one on the first attempt, is a refusal.
        return has_idempotency_key and attempt > 0 and code == "IDEMPOTENCY_KEY_IN_USE"
    return status in RETRYABLE_STATUSES


def _retry_after(headers: Message) -> Optional[float]:
    """Seconds to wait from Retry-After (delay-seconds such as 5, 0.5, .5 or 5., or an HTTP date);
    None if absent or unreadable. No sign, exponent or inner space."""
    value = (headers.get("Retry-After") or "").strip(_SPACE)
    if not value:
        return None
    if _DELAY_SECONDS.fullmatch(value):
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None  # Python 3.9 raises TypeError for an unreadable date
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _backoff(attempt: int) -> float:
    """Exponential backoff with full jitter."""
    return random.uniform(0, min(MAX_BACKOFF, INITIAL_BACKOFF * 2 ** min(attempt, 10)))
