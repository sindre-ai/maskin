#!/usr/bin/env bash
# C5 — a busy SeaweedFS master port must not abort the no-Docker bootstrap.
#
# Holds 127.0.0.1:9333 itself (the port agent sandboxes give the browser proxy),
# runs the real scripts/bootstrap-local-devstack.sh with S3_MASTER_PORT unset and
# asserts it routes around the holder: exit 0, an env.sh whose S3_MASTER_PORT is
# not 9333 and is live, exactly one warning, the holder still alive, an idempotent
# re-run, and a pinned free port honoured without a warning.
#
# Needs a Postgres/SeaweedFS download unless MASKIN_DEVSTACK_CACHE_DIR points at
# an already populated devstack dir: its postgres-*, weed-* and vendor-lib-*
# directories are copied in (never pgdata) so this check does not re-download.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOLD_PORT=9333
CHECK_DIR="$(mktemp -d)"
HOLDER_PID=""

fail() {
	echo "devstack-port-conflict: FAIL: $*" >&2
	exit 1
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# weed shuts down gracefully and can take longer than 10 s; SIGKILL after 30 s.
stop_weed() {
	local pid
	pid="$(cat "$CHECK_DIR/weed.pid" 2>/dev/null)" || return 0
	kill "$pid" 2>/dev/null || return 0
	for _ in $(seq 1 60); do
		[ -d "/proc/$pid" ] || return 0
		sleep 0.5
	done
	kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
	local rc=$?
	stop_weed
	local pg_ctl lib
	pg_ctl="$(ls -d "$CHECK_DIR"/postgres-*/bin/pg_ctl 2>/dev/null | head -1)"
	lib="$(ls -d "$CHECK_DIR"/vendor-lib-* 2>/dev/null | head -1)"
	if [ -n "$pg_ctl" ] && [ -d "$CHECK_DIR/pgdata" ]; then
		LD_LIBRARY_PATH="$lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
			"$pg_ctl" -D "$CHECK_DIR/pgdata" stop -m immediate >/dev/null 2>&1 || true
	fi
	if [ -n "$HOLDER_PID" ]; then
		kill "$HOLDER_PID" 2>/dev/null || true
	fi
	rm -rf "$CHECK_DIR"
	exit "$rc"
}
trap cleanup EXIT

# A holder we control. Fail closed: without it every assertion below is vacuous.
command -v node >/dev/null 2>&1 || fail "no listener tool: node is required to hold port $HOLD_PORT"

if port_busy "$HOLD_PORT"; then
	fail "port $HOLD_PORT is already in use before the check started; free it and re-run"
fi
node -e "require('net').createServer().listen($HOLD_PORT, '127.0.0.1', () => setInterval(() => {}, 1000))" &
HOLDER_PID=$!
for _ in $(seq 1 20); do
	port_busy "$HOLD_PORT" && break
	sleep 0.25
done
# Harness control: our own probe must see the port busy before bootstrap runs.
port_busy "$HOLD_PORT" || fail "harness control: $HOLD_PORT is not busy after starting the holder"

if [ -n "${MASKIN_DEVSTACK_CACHE_DIR:-}" ] && [ -d "$MASKIN_DEVSTACK_CACHE_DIR" ]; then
	for d in "$MASKIN_DEVSTACK_CACHE_DIR"/postgres-* "$MASKIN_DEVSTACK_CACHE_DIR"/weed-* "$MASKIN_DEVSTACK_CACHE_DIR"/vendor-lib-*; do
		[ -d "$d" ] && cp -a "$d" "$CHECK_DIR/"
	done
fi

export MASKIN_DEVSTACK_DIR="$CHECK_DIR"
unset S3_MASTER_PORT

run_bootstrap() {
	# $1 = label. Leaves $CHECK_DIR/$1.out, $1.err and sets BOOT_RC.
	timeout 600 bash "$REPO_ROOT/scripts/bootstrap-local-devstack.sh" >"$CHECK_DIR/$1.out" 2>"$CHECK_DIR/$1.err"
	BOOT_RC=$?
}

env_port() { sed -n 's/^export S3_MASTER_PORT="\([0-9]*\)"$/\1/p' "$CHECK_DIR/env.sh"; }

# --- first run: 9333 held, S3_MASTER_PORT unset -----------------------------
run_bootstrap first
if [ "$BOOT_RC" -ne 0 ] || [ ! -f "$CHECK_DIR/env.sh" ]; then
	[ -f "$CHECK_DIR/env.sh" ] && missing="env.sh present" || missing="env.sh missing"
	tail -n 20 "$CHECK_DIR/first.err" >&2
	fail "bootstrap exited $BOOT_RC with $HOLD_PORT held ($missing)"
fi

grep -q '^export DATABASE_URL=' "$CHECK_DIR/env.sh" || fail "env.sh has no DATABASE_URL"
first_port="$(env_port)"
[ -n "$first_port" ] || fail "env.sh has no exported S3_MASTER_PORT"
[ "$first_port" != "$HOLD_PORT" ] || fail "env.sh S3_MASTER_PORT is still $HOLD_PORT, the held port"
port_busy "$first_port" || fail "env.sh S3_MASTER_PORT $first_port is not accepting connections"

warnings="$(grep -c "master port $HOLD_PORT" "$CHECK_DIR/first.err" || true)"
[ "$warnings" = "1" ] || fail "expected exactly one stderr line matching 'master port $HOLD_PORT', got $warnings"

kill -0 "$HOLDER_PID" 2>/dev/null || fail "the foreign listener on $HOLD_PORT was killed"
port_busy "$HOLD_PORT" || fail "the foreign listener no longer holds $HOLD_PORT"

# --- re-run: weed already answering -----------------------------------------
run_bootstrap second
[ "$BOOT_RC" -eq 0 ] || { tail -n 20 "$CHECK_DIR/second.err" >&2; fail "re-run exited $BOOT_RC"; }
[ "$(env_port)" = "$first_port" ] || fail "re-run env.sh S3_MASTER_PORT is '$(env_port)', expected $first_port"
[ ! -s "$CHECK_DIR/second.err" ] || { cat "$CHECK_DIR/second.err" >&2; fail "re-run wrote to stderr"; }

# --- pinned free port is honoured, no warning --------------------------------
stop_weed
port_busy "$first_port" && fail "weed did not stop, cannot test a pinned port"
rm -f "$CHECK_DIR/weed.master.port"

pinned=9450
while port_busy "$pinned" || port_busy "$((pinned + 10000))"; do pinned=$((pinned + 1)); done
S3_MASTER_PORT="$pinned" run_bootstrap pinned
[ "$BOOT_RC" -eq 0 ] || { tail -n 20 "$CHECK_DIR/pinned.err" >&2; fail "pinned run exited $BOOT_RC"; }
[ "$(env_port)" = "$pinned" ] || fail "pinned S3_MASTER_PORT $pinned not honoured, env.sh says '$(env_port)'"
[ ! -s "$CHECK_DIR/pinned.err" ] || { cat "$CHECK_DIR/pinned.err" >&2; fail "pinned free port produced a warning"; }

echo "devstack-port-conflict: ok (moved off $HOLD_PORT to $first_port, re-run stable, pinned $pinned honoured)"
