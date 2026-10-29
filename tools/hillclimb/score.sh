#!/usr/bin/env bash
# Hillclimb scorer: SCORE = bun test passing-test count (higher = better).
# Gate: `bun test` must exit 0 (0 fail) AND `bun run typecheck` must exit 0.
# Prints SCORE=<float>, exits non-zero when gate fails.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
# 1) bun test with timeout
if ! timeout 120 bun test >"$OUT" 2>&1; then
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
if ! timeout 120 bun run typecheck >"$OUT" 2>&1; then
  cat "$OUT"
  echo "SCORE=$PASS"
  echo "PASS=$PASS FAIL=$FAIL"
  echo "GATE=fail-typecheck"
  exit 1
fi
echo "SCORE=$PASS"
echo "PASS=$PASS FAIL=$FAIL"
echo "GATE=pass"
