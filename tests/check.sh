#!/usr/bin/env bash
# Copyright 2026 Stow Cards
# SPDX-License-Identifier: Apache-2.0
#
# Builds one example and runs its demo against tests/mock_gateway.py, checking
# the behaviour every example promises: retries that reuse the Idempotency-Key,
# the 409 IDEMPOTENCY_KEY_IN_USE rule, one-line errors and exit codes, and a
# key that is never printed. Nothing here calls the real API.
#
#   tests/check.sh <python|php|ruby|java|dotnet|go>
#
# Needs the language's toolchain and python3 (for the mock) on PATH.
set -uo pipefail

EXAMPLE=${1:?usage: tests/check.sh <python|php|ruby|java|dotnet|go>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MOCK=$ROOT/tests/mock_gateway.py
PORT=${STOW_CHECK_PORT:-6299}
PY=${PYTHON:-python3}
WORK=$(mktemp -d)
MOCK_PID=
FAILED=0

cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT
cd "$ROOT" || exit 1

build() {
  case $EXAMPLE in
    python) "$PY" -m py_compile python/*.py && rm -rf python/__pycache__ ;;
    php) for f in php/*.php; do php -l "$f" >/dev/null || return 1; done ;;
    ruby) ruby -wc ruby/stow_client.rb && ruby -wc ruby/demo.rb ;;
    java) (cd java && mvn -q -B compile) ;;
    dotnet) (cd dotnet && dotnet build -nologo -v quiet) ;;
    go) (cd go && test -z "$(gofmt -l .)" && go vet ./... && go build -o "$WORK/go-demo" .) ;;
    *) echo "unknown example: $EXAMPLE" >&2; return 1 ;;
  esac
}

demo() {
  case $EXAMPLE in
    python) (cd python && "$PY" -B demo.py) ;;
    php) (cd php && php demo.php) ;;
    ruby) (cd ruby && ruby demo.rb) ;;
    java) (cd java && mvn -q -B exec:java) ;;
    dotnet) (cd dotnet && dotnet run --no-build) ;;
    go) "$WORK/go-demo" ;;
  esac
}

start_mock() {
  "$PY" -I "$MOCK" "$PORT" "$@" >"$WORK/mock.log" 2>&1 &
  MOCK_PID=$!
  for _ in $(seq 1 50); do
    "$PY" -c "import socket; socket.create_connection(('127.0.0.1', $PORT), 0.2)" 2>/dev/null && return 0
    sleep 0.1
  done
  echo "the mock gateway did not start" >&2
  return 1
}

stop_mock() {
  kill "$MOCK_PID" 2>/dev/null
  wait "$MOCK_PID" 2>/dev/null
  MOCK_PID=
}

# run <key> [base url]: runs the demo, leaving its exit code in RC and its output in $WORK.
run() {
  local key=$1 base=${2:-http://127.0.0.1:$PORT/api/v1}
  if [ "$key" = "-" ]; then
    (unset STOW_API_KEY; export STOW_BASE_URL="$base"; demo) >"$WORK/out" 2>"$WORK/err"
  else
    (export STOW_API_KEY="$key" STOW_BASE_URL="$base"; demo) >"$WORK/out" 2>"$WORK/err"
  fi
  RC=$?
}

expect() { # expect <description> <condition...>
  local what=$1
  shift
  if "$@"; then
    echo "  ok    $what"
  else
    echo "  FAIL  $what"
    echo "--- stdout"; tail -20 "$WORK/out"
    echo "--- stderr"; cat "$WORK/err"
    FAILED=1
  fi
}

patches() { grep -c '"method": "PATCH"' "$WORK/mock.log"; }
keys() { grep '"method": "PATCH"' "$WORK/mock.log" | grep -o '"idempotencyKey": "[^"]*"' | sort -u | wc -l | tr -d ' '; }
gets_of_programs() { grep '"method": "GET"' "$WORK/mock.log" | grep -c '/merchants/me/programs'; }
error_lines() { grep -c -E '^(Error|Configuration error):' "$WORK/err"; }
balance_60() { grep -q -E 'Balance[^0-9]*60\b' "$WORK/out"; }
eq() { [ "$1" = "$2" ]; }

echo "== $EXAMPLE: build"
if ! build; then
  echo "  FAIL  build"
  exit 1
fi
echo "  ok    build"

for mode in normal --flaky --in-use --in-use-first; do
  echo "== $EXAMPLE: mock $mode"
  if [ "$mode" = normal ]; then start_mock || exit 1; else start_mock "$mode" || exit 1; fi
  run stow_ci_check_key
  stop_mock
  case $mode in
    normal) want_patches=1 ;;
    --flaky) want_patches=2 ;;
    --in-use) want_patches=3 ;;
    --in-use-first) want_patches=1 ;;
  esac
  expect "$want_patches PATCH request(s)" eq "$(patches)" "$want_patches"
  expect "one Idempotency-Key across them" eq "$(keys)" 1
  if [ "$mode" = --in-use-first ]; then
    expect "exit code 1" eq "$RC" 1
    expect "one error line naming 409 IDEMPOTENCY_KEY_IN_USE" \
      bash -c "[ \"\$(grep -c -E '^(Error|Configuration error):' '$WORK/err')\" = 1 ] && grep -q '409 IDEMPOTENCY_KEY_IN_USE' '$WORK/err'"
  else
    expect "exit code 0" eq "$RC" 0
    expect "balance 60 printed" balance_60
    expect "no error output" eq "$(error_lines)" 0
  fi
done

echo "== $EXAMPLE: invalid key"
start_mock || exit 1
run stow_invalid_ci_key
stop_mock
expect "exit code 1" eq "$RC" 1
expect "one request, not retried" eq "$(gets_of_programs)" 1
expect "one error line naming 401 INVALID_API_KEY" \
  bash -c "[ \"\$(grep -c -E '^Error:' '$WORK/err')\" = 1 ] && grep -q '401 INVALID_API_KEY' '$WORK/err'"

echo "== $EXAMPLE: configuration errors"
run -
expect "missing key exits 2" eq "$RC" 2
run "$(printf 'stow_SECRET_ci_check\nsecond-line')"
expect "key with a line break exits 2" eq "$RC" 2
expect "the key is not echoed" bash -c "! grep -q 'SECRET_ci_check' '$WORK/out' '$WORK/err'"
run stow_ci_check_key http://api.example.com/api/v1
expect "plain http to a public host exits 2" eq "$RC" 2

rm -rf "$ROOT/python/__pycache__"
if [ "$FAILED" -ne 0 ]; then
  echo "== $EXAMPLE: FAILED"
  exit 1
fi
echo "== $EXAMPLE: all checks passed"
