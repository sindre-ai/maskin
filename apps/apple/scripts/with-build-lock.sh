#!/usr/bin/env bash
# Serialise heavy Swift/Xcode builds when several agents share one machine. Without this, N
# parallel cold builds each recompile the generated API client and thrash the CPU (load average
# in the hundreds). Waiters queue; a dead holder's stale lock is cleared.
#
#   scripts/with-build-lock.sh swift test --scratch-path "$SCRATCH/shared" -j 8
#   scripts/with-build-lock.sh xcodebuild ... -derivedDataPath "$SCRATCH/shared-dd" ...
set -u
LOCK="${MASKIN_BUILD_LOCK:-/private/tmp/claude-501/-Users-krumhausen-Documents-GitHub-maskin-v2-merge/aa0f840c-90b9-40f2-b841-4230b49c1ea8/scratchpad/build.lock}"
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
	pid=$(cat "$LOCK/pid" 2>/dev/null || true)
	if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
		rm -rf "$LOCK"
		continue
	fi
	[ $((waited % 30)) -eq 0 ] && echo "[build-lock] waiting for pid ${pid:-?} ..." >&2
	waited=$((waited + 3))
	sleep 3
done
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM
"$@"
