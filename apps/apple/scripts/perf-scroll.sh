#!/usr/bin/env bash
# Scroll smoothness and memory for the long chat thread and the For you feed, against the demo
# server in perf mode. Runs Apps/MaskinUITests/ScrollPerfTests and prints the median of every
# metric over PERF_ITERATIONS runs (default 5), per test.
#
#   scripts/perf-scroll.sh                  # builds, starts the server, runs, prints medians
#   SIM=<udid> DERIVED=<dir> scripts/perf-scroll.sh
#   SKIP_BUILD=1 scripts/perf-scroll.sh     # reuse DERIVED from an earlier run
#
# Env: SIM (simulator udid, required), DERIVED (derived data dir, default /tmp/maskin-perf-dd),
# PORT (demo server, default 3010; the app is built to talk to it), PERF_ITERATIONS, OUT (log dir).
# Simulator numbers compare two builds on one machine. They are not device numbers.
set -euo pipefail
cd "$(dirname "$0")/.."
SIM="${SIM:?set SIM to a simulator udid (xcrun simctl create ...)}"
DERIVED="${DERIVED:-/tmp/maskin-perf-dd}"
PORT="${PORT:-3010}"
OUT="${OUT:-/tmp/maskin-perf}"
mkdir -p "$OUT"
dest="id=$SIM"

if ! curl -sf "localhost:$PORT/api/health" >/dev/null; then
	DEMO_PERF=1 PORT="$PORT" node scripts/demo-server/server.mjs >"$OUT/server.log" 2>&1 &
	server=$!
	trap 'kill $server 2>/dev/null || true' EXIT
	until curl -sf "localhost:$PORT/api/health" >/dev/null; do sleep 1; done
fi

if [ -z "${SKIP_BUILD:-}" ]; then
	xcodegen generate >/dev/null
	xcodebuild -project Maskin.xcodeproj -scheme Maskin -destination "$dest" -configuration Debug \
		-derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO "MASKIN_API_BASE_URL=http://localhost:$PORT" \
		build-for-testing >"$OUT/build.log" 2>&1 || { tail -30 "$OUT/build.log"; exit 1; }
fi

xcrun simctl boot "$SIM" 2>/dev/null || true
TEST_RUNNER_PERF_ITERATIONS="${PERF_ITERATIONS:-5}" xcodebuild -project Maskin.xcodeproj -scheme Maskin \
	-destination "$dest" -configuration Debug -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO \
	"MASKIN_API_BASE_URL=http://localhost:$PORT" \
	-only-testing:MaskinUITests/ScrollPerfTests test-without-building >"$OUT/test.log" 2>&1 || true

node scripts/perf-medians.mjs "$OUT/test.log"
