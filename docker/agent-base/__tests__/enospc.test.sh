#!/bin/bash
# Synthetic disk-fill test for the ENOSPC trap in agent-run.sh.
#
# AC-T7 (from bet/dev-agent-token-waste): a session that hits ENOSPC must trap
# it, signal `/sessions/:id/complete` with exitCode=28, the VM stops, and no
# downstream session is created.
#
# We can't actually fill the workspace disk in CI, so we source the relevant
# helpers from agent-run.sh into a sub-shell and steer is_disk_full() via
# ENOSPC_PROBE_PATHS — pointing it at an unwriteable tmp dir to fake a full
# mount, and at a writeable dir to confirm the negative case. The contract
# under test is:
#   - classify_exit_code(0)           -> 0   (success passes through)
#   - classify_exit_code(1) on full   -> 28  (any non-zero is promoted)
#   - classify_exit_code(1) on free   -> 1   (non-ENOSPC failure is preserved)
#   - classify_exit_code(28) on free  -> 28  (idempotent, no re-probe needed)
#   - report_complete() POSTs exitCode=28 to /sessions/:id/complete on full disk
#
# Run with: bash docker/agent-base/__tests__/enospc.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_RUN_SH="$(cd "$SCRIPT_DIR/.." && pwd)/agent-run.sh"

if [ ! -f "$AGENT_RUN_SH" ]; then
  echo "FAIL: cannot locate agent-run.sh at $AGENT_RUN_SH" >&2
  exit 1
fi

# Load only the function definitions (everything above the main flow). The
# sentinel is the first top-level `echo "[system] Starting agent session"`
# line. We also strip the top-level `resolve_agent_server_url` invocation that
# sits between the function defs and the main flow, and disable `set -e` so the
# trap doesn't fire on this sourcing path. Finally, we install a no-op `trap`
# wrapper so agent-run.sh's `trap report_complete EXIT` doesn't poison our
# test process's own exit trap (we want to drive report_complete manually).
TMP_LIB="$(mktemp)"
awk '
  /^echo "\[system\] Starting agent session/{exit}
  /^set -eo pipefail/{print "set +eo pipefail"; next}
  /^resolve_agent_server_url$/{next}
  /^trap report_complete EXIT/{next}
  {print}
' "$AGENT_RUN_SH" > "$TMP_LIB"
# shellcheck disable=SC1090
source "$TMP_LIB"
set +eo pipefail

passed=0
failed=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    passed=$((passed + 1))
    echo "PASS: $name"
  else
    failed=$((failed + 1))
    echo "FAIL: $name - expected '$expected' got '$actual'" >&2
  fi
}

# Silence the deliberate "Permission denied" stderr that is_disk_full emits
# when its probe writes are blocked - those failures ARE the signal under test,
# not test errors. The wire-test below restores stderr explicitly.
exec 9>&2
exec 2>/dev/null

# Fake a full mount with a path the test user cannot create files in.
FAKE_FULL_DIR="$(mktemp -d)"
chmod 0500 "$FAKE_FULL_DIR" # readable + executable, NOT writable
FAKE_FREE_DIR="$(mktemp -d)"

cleanup() {
  chmod 0700 "$FAKE_FULL_DIR" 2>/dev/null || true
  rm -rf "$FAKE_FULL_DIR" "$FAKE_FREE_DIR" "$TMP_LIB"
}
trap cleanup EXIT

# Sanity: the test user really can't write to FAKE_FULL_DIR.
if : > "${FAKE_FULL_DIR}/.writable-canary" 2>/dev/null; then
  echo "SKIP: test user can write to a 0500 dir (likely running as root) - is_disk_full probe cannot be faked here" >&9
  rm -f "${FAKE_FULL_DIR}/.writable-canary"
  exit 0
fi

# --- is_disk_full() ---------------------------------------------------------
ENOSPC_PROBE_PATHS="$FAKE_FREE_DIR"
is_disk_full
assert_eq "is_disk_full returns 1 (false) when probe paths are writeable" "1" "$?"

ENOSPC_PROBE_PATHS="$FAKE_FULL_DIR"
is_disk_full
assert_eq "is_disk_full returns 0 (true) when probe path is unwriteable" "0" "$?"

ENOSPC_PROBE_PATHS="$FAKE_FREE_DIR $FAKE_FULL_DIR"
is_disk_full
assert_eq "is_disk_full returns 0 (true) when ANY probe path is unwriteable" "0" "$?"

ENOSPC_PROBE_PATHS="/nonexistent/path-$$"
is_disk_full
# Missing dirs are skipped, df fallback applies; for the test we assert that a
# missing-only path does NOT incorrectly trip ENOSPC.
assert_eq "is_disk_full returns 1 (false) when probe paths don't exist (skipped)" "1" "$?"

# --- classify_exit_code() ---------------------------------------------------
ENOSPC_PROBE_PATHS="$FAKE_FREE_DIR"
assert_eq "classify_exit_code(0) -> 0" "0" "$(classify_exit_code 0)"
assert_eq "classify_exit_code(1) on free disk -> 1" "1" "$(classify_exit_code 1)"
assert_eq "classify_exit_code(28) on free disk -> 28 (idempotent)" "28" "$(classify_exit_code 28)"
assert_eq "classify_exit_code(137) on free disk -> 137 (SIGKILL preserved)" "137" "$(classify_exit_code 137)"

ENOSPC_PROBE_PATHS="$FAKE_FULL_DIR"
assert_eq "classify_exit_code(1) on full disk -> 28" "28" "$(classify_exit_code 1)"
assert_eq "classify_exit_code(2) on full disk -> 28" "28" "$(classify_exit_code 2)"
assert_eq "classify_exit_code(137) on full disk -> 28" "28" "$(classify_exit_code 137)"
assert_eq "classify_exit_code(0) on full disk -> 0 (success passes through)" "0" "$(classify_exit_code 0)"

# --- report_complete() POSTs the right body ---------------------------------
# Restore stderr for the wire-test - curl + nc errors that aren't part of the
# signal-under-test should be visible if anything misfires.
exec 2>&9
# Start a tiny netcat listener to capture what report_complete posts. The
# listener exits after one connection so the test doesn't hang.
if command -v nc >/dev/null 2>&1; then
  POST_LOG="$(mktemp)"
  PORT=$(( ( RANDOM % 1000 ) + 19000 ))
  ( nc -l -p "$PORT" -q 1 >"$POST_LOG" 2>/dev/null <<<"HTTP/1.0 200 OK
Content-Length: 0

" ) &
  NC_PID=$!
  sleep 0.2

  AGENT_SERVER_URL="http://127.0.0.1:${PORT}"
  SESSION_ID="sess-test-enospc"
  AGENT_EXIT_CODE=1
  ENOSPC_PROBE_PATHS="$FAKE_FULL_DIR"
  report_complete

  wait $NC_PID 2>/dev/null || true
  body="$(awk '/^$/{flag=1;next} flag' "$POST_LOG")"
  rm -f "$POST_LOG"
  case "$body" in
    *'"exitCode":28'*)
      passed=$((passed + 1))
      echo "PASS: report_complete posts exitCode=28 when agent failed on a full disk"
      ;;
    *)
      failed=$((failed + 1))
      echo "FAIL: report_complete body did not contain exitCode=28 — got: $body" >&2
      ;;
  esac

  # And the reverse: on a free disk a generic failure stays as its original code.
  POST_LOG="$(mktemp)"
  PORT=$(( ( RANDOM % 1000 ) + 20000 ))
  ( nc -l -p "$PORT" -q 1 >"$POST_LOG" 2>/dev/null <<<"HTTP/1.0 200 OK
Content-Length: 0

" ) &
  NC_PID=$!
  sleep 0.2

  AGENT_SERVER_URL="http://127.0.0.1:${PORT}"
  AGENT_EXIT_CODE=2
  ENOSPC_PROBE_PATHS="$FAKE_FREE_DIR"
  report_complete

  wait $NC_PID 2>/dev/null || true
  body="$(awk '/^$/{flag=1;next} flag' "$POST_LOG")"
  rm -f "$POST_LOG"
  case "$body" in
    *'"exitCode":2'*)
      passed=$((passed + 1))
      echo "PASS: report_complete preserves non-ENOSPC failure codes"
      ;;
    *)
      failed=$((failed + 1))
      echo "FAIL: report_complete body did not preserve exitCode=2 — got: $body" >&2
      ;;
  esac
else
  echo "SKIP: nc not available — skipping report_complete wire-test" >&2
fi

echo
echo "ENOSPC trap test: $passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0
