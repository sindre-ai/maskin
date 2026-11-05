#!/usr/bin/env bash
# Runs the must-keep UI tests (docs/must-keep-features.md) against the offline demo server.
# Starts the demo server on a free port, runs MustKeepTests on an iOS simulator, stops the server.
#
#   apps/apple/scripts/run-must-keep.sh                      # all rows
#   apps/apple/scripts/run-must-keep.sh MustKeepTests/testMK04_ThreadWithRepliesOpens
#
# Env: DEST (simulator, default 'platform=iOS Simulator,name=iPhone 17'),
#      DERIVED (derived data dir, default a private temp dir; set one per agent to avoid clashes),
#      MUSTKEEP_DUMP_DIR (where a failing step leaves a screenshot + element tree).
set -euo pipefail
cd "$(dirname "$0")/.."

only="${1:-MustKeepTests}"
dest="${DEST:-platform=iOS Simulator,name=iPhone 17}"
derived="${DERIVED:-$(mktemp -d)/dd}"
dump="${MUSTKEEP_DUMP_DIR:-$(mktemp -d)}"
mkdir -p "$dump"

[ -d Maskin.xcodeproj ] || xcodegen generate

port=$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")
PORT="$port" node scripts/demo-server/server.mjs >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://localhost:$port/api/health" >/dev/null && break; sleep 0.5; done

echo "demo server on :$port, failure evidence in $dump"
# CODE_SIGNING_ALLOWED=NO: a plain simulator build fails signing the Computer resources bundle.
TEST_RUNNER_MUSTKEEP_DUMP_DIR="$dump" xcodebuild test -project Maskin.xcodeproj -scheme Maskin \
	-destination "$dest" -derivedDataPath "$derived" CODE_SIGNING_ALLOWED=NO \
	MASKIN_API_BASE_URL="http://localhost:$port" -only-testing:"MaskinUITests/$only"
