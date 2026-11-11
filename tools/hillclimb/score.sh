#!/usr/bin/env bash
# Hillclimb scorer: SCORE = bun test passing-test count (higher = better).
# Gate: `bun test` must exit 0 (0 fail) AND `bun run typecheck` must exit 0.
# Prints SCORE=<float>, exits non-zero when gate fails.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
    return $?
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
    return $?
  fi
  "$@" &
  local pid=$!
  (
    sleep "$secs" &
    local sp=$!
    trap 'kill "$sp" 2>/dev/null || true; exit 0' TERM INT
    wait "$sp" 2>/dev/null || exit 0
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    kill -KILL "$pid" 2>/dev/null || true
  ) >/dev/null 2>&1 &
  local watcher=$!
  local rc=0
  wait "$pid" || rc=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

# 1) bun test with timeout
if ! run_with_timeout 120 bun test >"$OUT" 2>&1; then
  cat "$OUT"
  PASS="$(sed -n 's/^ *\([0-9][0-9]*\) pass.*/\1/p' "$OUT" | tail -n 1)"
  echo "SCORE=${PASS:-0}"
  echo "GATE=fail-bun-test"
  exit 1
fi
PASS="$(sed -n 's/^ *\([0-9][0-9]*\) pass.*/\1/p' "$OUT" | tail -n 1)"
FAIL="$(sed -n 's/^ *\([0-9][0-9]*\) fail.*/\1/p' "$OUT" | tail -n 1)"
PASS="${PASS:-0}"
FAIL="${FAIL:-0}"
if [ "$FAIL" != "0" ]; then
  echo "SCORE=$PASS"
  echo "PASS=$PASS FAIL=$FAIL"
  echo "GATE=fail-count-nonzero"
  exit 1
fi
# 2) typecheck gate with timeout
if ! run_with_timeout 120 bun run typecheck >"$OUT" 2>&1; then
  cat "$OUT"
  echo "SCORE=$PASS"
  echo "PASS=$PASS FAIL=$FAIL"
  echo "GATE=fail-typecheck"
  exit 1
fi
echo "SCORE=$PASS"
echo "PASS=$PASS FAIL=$FAIL"
echo "GATE=pass"
