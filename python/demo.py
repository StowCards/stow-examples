#!/usr/bin/env python3
"""Stow Cards API example: list programs, enrol a member, award points, read the member back.

    export STOW_API_KEY=stow_replace_with_your_key
    python3 demo.py
"""
from __future__ import annotations

import logging
import sys
import time
import uuid
from typing import Any

from stow_client import StowApiError, StowClient, StowConfigError, StowConnectionError


def obj(value: Any) -> dict[str, Any]:
    """The value if it is a JSON object, else an empty one (for optional nested fields)."""
    return value if isinstance(value, dict) else {}


def balance_of(member: dict[str, Any], program: dict[str, Any]) -> tuple[str, Any]:
    """The fieldValues key that holds the balance, and the value stored under it (None if absent)."""
    snapshot = obj(member.get("program"))  # a ProgramSummary; null if the program was deleted
    key = next(
        (k for k in (snapshot.get("balanceKey"), program.get("balanceKey")) if isinstance(k, str) and k),
        "points",
    )
    return key, obj(member.get("fieldValues")).get(key)


def main() -> int:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="   (retry) %(message)s")
    client = StowClient()
    print(f"Stow Cards API at {client.base_url}\n")

    # 1. Pick the first active program.
    programs = client.list_programs()
    print(f"1. Listed {len(programs)} program(s)")
    program = None
    for candidate in programs:
        if candidate.get("status") == "active":
            program = candidate
            break
        print(f'   Skipped "{candidate.get("name")}" (status: {candidate.get("status")})')
    if program is None:
        fail(
            "Error: No active program on this merchant. Publish one in the Stow Cards console "
            "(Pass Designer) and run the example again."
        )
        return 1
    print(f'   Using "{program.get("name")}" ({program["_id"]})')

    # 2. Enrol a new member. A fresh email per run avoids the (programId, email) dedupe.
    email = f"dev+{int(time.time() * 1000)}@example.com"
    member = client.enroll_member(program["_id"], "Ada", "Lovelace", email, initial_points=50)
    print(f"2. Enrolled {email}")
    if member.get("deduped") is True:
        print("   deduped: true (this email was already in the program, so the API returned the existing member)")
    issuance = obj(member.get("passIssuance"))
    for wallet, name in (("apple", "Apple Wallet"), ("google", "Google Wallet")):
        if issuance.get(wallet) is False:
            print(f"   Note: the {name} pass could not be built, so the member has no {name} link.")

    # 3. Award 10 points. One Idempotency-Key for this gesture, resent unchanged on every retry.
    idempotency_key = str(uuid.uuid4())
    print(f"3. Awarding 10 points (Idempotency-Key {idempotency_key})")
    result = client.adjust_points(
        member["id"],
        delta=10,
        change_message="Thanks for visiting!",
        idempotency_key=idempotency_key,
    )
    print(f"   Balance {result.get('previous')} -> {result.get('current')}")

    # 4. Read the member back. memberCode is the Member ID; id and serialNumber are never shown as one.
    detail = client.get_member(member["id"])
    key, balance = balance_of(detail, program)
    apple = obj(detail.get("apple"))
    google = obj(detail.get("google"))
    print("4. Member")
    print(f"   Member ID:      {detail.get('memberCode') or '(none: enrolled before Member IDs existed)'}")
    print(f"   Balance:        {'n/a' if balance is None else balance} {key}")
    print(f"   Apple Wallet:   {apple.get('passUrl') or '(no link)'} (mode: {apple.get('mode', 'unknown')})")
    print(f"   Google Wallet:  {google.get('saveUrl') or '(no link)'} (mode: {google.get('mode', 'unknown')})")
    if "stub" in (apple.get("mode"), google.get("mode")):
        print(
            "\nStub mode: this server has no credentials for that wallet, so the pass is not signed "
            "with a real certificate and updates do not reach a phone."
        )
    return 0


def fail(line: str) -> None:
    """Write one error line to stderr, after the progress lines already on stdout."""
    sys.stdout.flush()
    print(" ".join(line.split()), file=sys.stderr, flush=True)


def run() -> int:
    try:
        return main()
    except StowConfigError as exc:
        fail(f"Configuration error: {exc}")
        return 2
    except StowApiError as exc:
        fail(f"Error: {exc}")  # <status> <CODE>: <message> (request id <id>)
        return 1
    except StowConnectionError as exc:
        fail(f"Error: {exc.code}: {exc}")  # CONNECTION_ERROR or TIMEOUT
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(run())
