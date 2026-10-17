#!/usr/bin/env bash
# Runs the MCP conformance matrix (packages/mcp/src/__tests__/conformance)
# against the BUILT server, the way production runs it, with both client styles
# in play: raw JSON-RPC and the SDK v2 client in each negotiation mode.
#
# The server is started twice on one database, which is what proves tools/list
# is byte-identical across a restart (the digest of the first run is compared
# by the second):
#   1. MASKIN_MCP_MODERN=on,  a lowered response cap, matrix with --flag on
#   2. MASKIN_MCP_MODERN=off,                         matrix with --flag off
#
# Needs: a migrated Postgres (DATABASE_URL), INTEGRATION_ENCRYPTION_KEY, and the
# packages built (apps/dev/dist/index.js). MCP_CONFORMANCE_STRICT=1 makes a row
# that is "pending" (server lacks a feature it needs) a failure.
#
# SERVER_CMD overrides how the server is launched, e.g. to run from source.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${INTEGRATION_ENCRYPTION_KEY:?INTEGRATION_ENCRYPTION_KEY is required}"

PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"
SERVER_CMD="${SERVER_CMD:-node apps/dev/dist/index.js}"
CAP_TOKENS=300
WORK="$(mktemp -d)"
SERVER_PID=""

stop_server() {
	if [ -n "$SERVER_PID" ]; then
		kill "$SERVER_PID" 2>/dev/null || true
		wait "$SERVER_PID" 2>/dev/null || true
		SERVER_PID=""
	fi
}
trap 'stop_server; rm -rf "$WORK"' EXIT

# start_server <flag> [response cap tokens]
start_server() {
	local flag="$1" cap="${2:-}"
	local -a extra=()
	[ -n "$cap" ] && extra+=("MCP_RESPONSE_MAX_TOKENS=$cap")
	env PORT="$PORT" MASKIN_MCP_MODERN="$flag" ${extra[@]+"${extra[@]}"} $SERVER_CMD \
		>"$WORK/server-$flag.log" 2>&1 &
	SERVER_PID=$!
	for _ in $(seq 1 60); do
		if curl -sf "$BASE/api/health" >/dev/null; then return 0; fi
		if ! kill -0 "$SERVER_PID" 2>/dev/null; then
			echo "mcp-conformance: server exited before /api/health answered:" >&2
			cat "$WORK/server-$flag.log" >&2
			exit 1
		fi
		sleep 1
	done
	echo "mcp-conformance: server did not answer /api/health within 60s:" >&2
	cat "$WORK/server-$flag.log" >&2
	exit 1
}

json_field() {
	node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).$1"
}

run_matrix() {
	local -a strict=()
	[ "${MCP_CONFORMANCE_STRICT:-0}" = "1" ] && strict+=(--strict)
	pnpm --filter @maskin/mcp conformance \
		--base-url "$BASE" \
		--api-key "$API_KEY" \
		--workspace-id "$WORKSPACE_ID" \
		--digest-file "$WORK/tools-digest" \
		${strict[@]+"${strict[@]}"} \
		"$@"
}

echo "== run 1: MASKIN_MCP_MODERN=on"
start_server on "$CAP_TOKENS"
# Public signup returns the API key and the actor's first workspace.
SIGNUP="$(curl -sf -X POST "$BASE/api/actors" -H 'content-type: application/json' -d "{
	\"type\": \"human\",
	\"name\": \"MCP conformance\",
	\"email\": \"mcp-conformance-$(date +%s)@example.test\",
	\"password\": \"mcp-conformance-$(date +%s)\"
}")"
API_KEY="$(json_field api_key <<<"$SIGNUP")"
WORKSPACE_ID="$(json_field workspace_id <<<"$SIGNUP")"
run_matrix --flag on --response-cap-tokens "$CAP_TOKENS" --transcript
stop_server

echo "== run 2: MASKIN_MCP_MODERN=off, after a restart"
start_server off
run_matrix --flag off
stop_server

echo "mcp-conformance: OK"
