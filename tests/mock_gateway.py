# Copyright 2026 Stow Cards
# SPDX-License-Identifier: Apache-2.0
"""Mock Stow Cards API gateway that the examples' checks run against.

Implements the four calls of the examples' flow with the response shapes of
the OpenAPI spec 1.0.14 (https://stow.cards/developers/openapi.json):

  GET   /api/v1/merchants/me/programs
  POST  /api/v1/merchants/me/members
  PATCH /api/v1/merchants/me/members/{id}/points
  GET   /api/v1/merchants/me/members/{id}

Auth: X-API-Key or "Authorization: ApiKey <key>". A key must start with
"stow_"; any key containing "invalid" answers 401 INVALID_API_KEY, a missing
key 401 NO_TOKEN. Nothing here touches the real API or issues wallet passes.

  python3 -I tests/mock_gateway.py [port] [--flaky | --in-use | --in-use-first] [--bind ADDR]

--flaky: the first attempt for every new Idempotency-Key answers 503, so a
client that retries must resend the SAME key.
--in-use: per new key, attempt 1 answers 503, attempt 2 answers 409
IDEMPOTENCY_KEY_IN_USE (an earlier attempt still holds the key), attempt 3
succeeds. A client following the rules succeeds on its third attempt.
--in-use-first: the FIRST attempt for every new key answers 409
IDEMPOTENCY_KEY_IN_USE. A correct client must not retry it, so the demo
stops with that error.
Every request is logged to stdout as one JSON line.
"""
import json
import re
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(next((a for a in sys.argv[1:] if a.isdigit()), "6199"))
FLAKY = "--flaky" in sys.argv
IN_USE = "--in-use" in sys.argv
IN_USE_FIRST = "--in-use-first" in sys.argv
# --bind 0.0.0.0 lets a Docker container reach the mock through host.docker.internal.
BIND = sys.argv[sys.argv.index("--bind") + 1] if "--bind" in sys.argv else "127.0.0.1"
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
PREFIX = "/api/v1"

PROGRAMS = [
    {"_id": "6a0000000000000000000001", "name": "Archived Card", "slug": "archived-card",
     "status": "archived", "productType": "loyalty_card", "balanceKey": "points",
     "pointsStep": 1, "currency": None, "createdAt": "2026-01-01T00:00:00.000Z"},
    {"_id": "6a0000000000000000000002", "name": "Harbor Coffee Rewards", "slug": "harbor-coffee",
     "status": "active", "productType": "loyalty_card", "balanceKey": "points",
     "pointsStep": 1, "currency": None,
     "barcode": {"format": "PKBarcodeFormatQR", "valueTemplate": "MEMBER-{{memberCode}}"},
     "createdAt": "2026-02-01T00:00:00.000Z"},
]
MEMBERS = {}          # id -> member dict
BY_EMAIL = {}         # (programId, email) -> id
IDEMPOTENCY = {}      # key -> (status, body)
ATTEMPTS = {}         # key -> attempts seen (for the fault modes)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def member_code():
    alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
    raw = uuid.uuid4().int
    return "".join(alphabet[(raw >> (5 * i)) % len(alphabet)] for i in range(10))


class Handler(BaseHTTPRequestHandler):
    server_version = "stow-mock/1.0"

    def log_message(self, *_):  # quiet default logging; we log JSON lines instead
        pass

    def _log(self, status, extra=None):
        line = {"method": self.command, "path": self.path, "status": status,
                "apiKey": bool(self._api_key()), "idempotencyKey": self.headers.get("Idempotency-Key"),
                "contentType": self.headers.get("Content-Type"), "userAgent": self.headers.get("User-Agent")}
        if extra:
            line.update(extra)
        print(json.dumps(line), flush=True)

    def _api_key(self):
        key = self.headers.get("X-API-Key")
        auth = self.headers.get("Authorization") or ""
        if not key and auth.startswith("ApiKey "):
            key = auth[len("ApiKey "):].strip()
        return key

    def _send(self, status, body, headers=None, log_extra=None):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Correlation-Id", self.headers.get("X-Correlation-Id") or str(uuid.uuid4()))
        self.send_header("RateLimit-Limit", "1000")
        self.send_header("RateLimit-Remaining", "999")
        self.send_header("RateLimit-Reset", "900")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)
        self._log(status, log_extra)

    def _error(self, status, code, message, **extra):
        self._send(status, {"success": False, "error": {"code": code, "message": message, **extra}})

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return "__invalid__"

    def _auth(self):
        key = self._api_key()
        if not key:
            self._error(401, "NO_TOKEN", "No API key or token was sent.")
            return False
        if not key.startswith("stow_") or "invalid" in key:
            self._error(401, "INVALID_API_KEY", "Invalid or expired API key.")
            return False
        return True

    def _route(self):
        if not self.path.startswith(PREFIX):
            self._error(404, "NOT_FOUND", "Route not found.")
            return
        if not self._auth():
            return
        path = self.path[len(PREFIX):].split("?", 1)[0]
        m = re.fullmatch(r"/merchants/me/members/([^/]+)/points", path)
        if self.command == "GET" and path == "/merchants/me/programs":
            return self._send(200, {"success": True, "data": PROGRAMS})
        if self.command == "POST" and path == "/merchants/me/members":
            return self._enroll()
        if self.command == "PATCH" and m:
            return self._points(m.group(1))
        m = re.fullmatch(r"/merchants/me/members/([^/]+)", path)
        if self.command == "GET" and m:
            return self._get_member(m.group(1))
        self._error(404, "NOT_FOUND", "Route not found.")

    def _enroll(self):
        body = self._body()
        if not isinstance(body, dict) or "json" not in (self.headers.get("Content-Type") or ""):
            return self._error(400, "BAD_REQUEST", "Send a JSON body with Content-Type: application/json.")
        missing = [f for f in ("programId", "firstName", "lastName", "email") if not body.get(f)]
        if missing:
            return self._error(400, "BAD_REQUEST", f"Missing fields: {', '.join(missing)}.")
        program = next((p for p in PROGRAMS if p["_id"] == body["programId"]), None)
        if program is None:
            return self._error(404, "NOT_FOUND", "Program not found.")
        if program["status"] != "active":
            return self._error(400, "BAD_REQUEST", "This program is archived and does not accept new members.")
        email = str(body["email"]).lower()
        existing = BY_EMAIL.get((program["_id"], email))
        if existing:
            return self._send(200, {"success": True, "data": {**MEMBERS[existing], "deduped": True,
                                                              "passIssuance": {"apple": True, "google": True}}})
        mid = str(uuid.uuid4())
        code = member_code()
        member = {
            "id": mid, "programId": program["_id"], "serialNumber": mid, "memberCode": code,
            "firstName": body["firstName"], "lastName": body["lastName"], "email": email,
            "status": "active", "passStatus": "created", "tags": [],
            "fieldValues": {"points": int(body.get("initialPoints") or 0)},
            "apple": {"passUrl": f"https://api.stow.cards/wallet/getpass/{mid}.pkpass", "installed": False, "mode": "stub"},
            "google": {"saveUrl": f"https://pay.google.com/gp/v/save/STUB-{mid}", "installed": False, "mode": "stub"},
            "barcode": {"value": f"MEMBER-{code}", "altText": code},
            "createdAt": now(),
        }
        MEMBERS[mid] = member
        BY_EMAIL[(program["_id"], email)] = mid
        self._send(201, {"success": True, "data": {**member, "passIssuance": {"apple": True, "google": True}}})

    def _points(self, mid):
        key = self.headers.get("Idempotency-Key")
        if key is not None and not KEY_RE.match(key):
            return self._error(400, "BAD_REQUEST",
                               "Idempotency-Key must be 8 to 128 characters of [A-Za-z0-9_-].")
        if key and key in IDEMPOTENCY:
            status, body = IDEMPOTENCY[key]
            return self._send(status, body, {"Idempotency-Replayed": "true"}, {"replayed": True})
        if key:
            attempt = ATTEMPTS[key] = ATTEMPTS.get(key, 0) + 1
            if attempt > 1:
                print(json.dumps({"note": "retry reused the Idempotency-Key", "key": key, "attempt": attempt}), flush=True)
            if IN_USE_FIRST and attempt == 1:
                return self._send(409, {"success": False, "error": {
                    "code": "IDEMPOTENCY_KEY_IN_USE",
                    "message": "An earlier request with this Idempotency-Key is still being processed."}},
                    log_extra={"forced409": True})
            if (FLAKY or IN_USE) and attempt == 1:
                return self._send(503, {"success": False, "error": {"code": "SERVICE_UNAVAILABLE",
                                                                    "message": "Upstream unavailable (mock fault mode)."}},
                                  log_extra={"forced503": True})
            if IN_USE and attempt == 2:
                return self._send(409, {"success": False, "error": {
                    "code": "IDEMPOTENCY_KEY_IN_USE",
                    "message": "An earlier request with this Idempotency-Key is still being processed."}},
                    log_extra={"forced409": True})
        member = MEMBERS.get(mid)
        if member is None:
            return self._error(404, "NOT_FOUND", "Member not found.")
        body = self._body()
        if not isinstance(body, dict):
            return self._error(400, "BAD_REQUEST", "Send a JSON body.")
        has_delta, has_value = "delta" in body, "value" in body
        if has_delta == has_value:
            return self._error(400, "BAD_REQUEST", "Send exactly one of delta or value.")
        amount = body["delta"] if has_delta else body["value"]
        if not isinstance(amount, int) or isinstance(amount, bool):
            return self._error(400, "BAD_REQUEST", "delta and value must be integers.")
        previous = int(member["fieldValues"].get("points", 0))
        current = max(0, previous + amount) if has_delta else max(0, amount)
        member["fieldValues"]["points"] = current
        member["passStatus"] = "in_use"
        member["updatedAt"] = now()
        result = {"success": True, "data": {
            "member": member, "previous": previous, "current": current,
            "passUpdate": {"serialNumber": member["serialNumber"], "lastUpdateTag": member["updatedAt"],
                           "rebuilt": False,
                           "apple": {"devicesNotified": 0, "devicesAttempted": 0, "mode": "stub"},
                           "google": {"objectPatched": False, "mode": "stub"}}}}
        if key:
            IDEMPOTENCY[key] = (200, result)
        self._send(200, result)

    def _get_member(self, mid):
        member = MEMBERS.get(mid)
        if member is None:
            return self._error(404, "NOT_FOUND", "Member not found.")
        program = next(p for p in PROGRAMS if p["_id"] == member["programId"])
        self._send(200, {"success": True, "data": {
            **member, "program": {"id": program["_id"], "name": program["name"], "programType": "points",
                                  "loyaltyStyle": "points", "passType": "storeCard",
                                  "balanceKey": program["balanceKey"], "pointsStep": program["pointsStep"],
                                  "currency": program["currency"]},
            "deviceCount": 0, "redeemedCount": 0}})

    do_GET = do_POST = do_PATCH = do_DELETE = _route


if __name__ == "__main__":
    print(json.dumps({"listening": f"http://{BIND}:{PORT}/api/v1", "flaky": FLAKY, "inUse": IN_USE,
                      "inUseFirst": IN_USE_FIRST}), flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
