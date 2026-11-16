#!/usr/bin/env bash
# Scroll clock time and memory for the long chat thread and the For you feed, against the demo
# server in perf mode. Runs the two scroll tests of Apps/MaskinUITests/ScrollPerfTests one at a
# time and prints the median clock time over PERF_ITERATIONS runs (default 5), per test, plus the
# app's peak and median resident memory during the scroll.
#
# Memory is sampled here, not by XCTest: Apple's memory metric crashes on the simulator. The
# simulator app is a normal process on the host, so ps reads its resident memory every second, and
# the test writes start and stop lines to a marker file around each scroll round (perf-memory.mjs
# joins the two). Hitch is not measured on the simulator (the metric crashes there); it needs a
# device trace.
#
#   scripts/perf-scroll.sh                  # builds, starts the server, runs, prints medians
#   SIM=<udid> DERIVED=<dir> scripts/perf-scroll.sh
#   SKIP_BUILD=1 scripts/perf-scroll.sh     # reuse DERIVED from an earlier run
#
# Env: SIM (simulator udid, required), DERIVED (derived data dir, default /tmp/maskin-perf-dd),
# PORT (demo server, default 3010; the app is built to talk to it), PERF_ITERATIONS, OUT (log dir,
# must be an absolute path: the test writes its markers and failure evidence there).
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

# Resident memory (KB) of the app process, once a second, as "<epoch seconds> <kb>" lines. The app is
# the Maskin.app inside this simulator's folder; the UI test runner is a different app.
sample_memory() {
	while :; do
		pid=$(pgrep -f "Devices/$SIM/.*/Maskin\.app/Maskin" | head -1 || true)
		if [ -n "$pid" ]; then
			rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)
			[ -n "$rss" ] && echo "$(date +%s) $rss"
		fi
		sleep 1
	done
}

run_test() {
	local t="$1"
	: >"$OUT/mem-$t.txt"
	: >"$OUT/marks-$t.txt"
	sample_memory >>"$OUT/mem-$t.txt" &
	local sampler=$!
	TEST_RUNNER_PERF_ITERATIONS="${PERF_ITERATIONS:-5}" TEST_RUNNER_PERF_MARK_FILE="$OUT/marks-$t.txt" \
		TEST_RUNNER_PERF_EVIDENCE_DIR="$OUT" xcodebuild -project Maskin.xcodeproj -scheme Maskin \
		-destination "$dest" -configuration Debug -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO \
		"MASKIN_API_BASE_URL=http://localhost:$PORT" \
		-only-testing:"MaskinUITests/ScrollPerfTests/$t" test-without-building >"$OUT/test-$t.log" 2>&1 || true
	kill "$sampler" 2>/dev/null || true
	wait "$sampler" 2>/dev/null || true
}

: >"$OUT/test.log"
for t in testChatThreadScroll testForYouScroll; do
	run_test "$t"
	cat "$OUT/test-$t.log" >>"$OUT/test.log"
done

echo "hitch: not measured on the simulator (the metric crashes there); needs a device trace"
node scripts/perf-memory.mjs "$OUT"
node scripts/perf-medians.mjs "$OUT/test.log"
