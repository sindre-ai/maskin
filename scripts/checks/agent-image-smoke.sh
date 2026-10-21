#!/usr/bin/env bash
# Boots the real agent-base image through its real entrypoint and agent-run.sh,
# with a stub `claude`, and proves a session reaches the point where it would
# launch the agent. Nothing else in CI runs agent-run.sh: the unit tests only
# read it as text, and the image is otherwise first exercised by the production
# session that follows the merge.
#
# agent-run.sh runs under `set -eo pipefail`, so any setup step that returns
# non-zero ends every session before the agent starts, with no error in the
# logs (PR #2070 shipped exactly that: a bare `return` after a failed flag test).
# That is why most cases here run with the optional features OFF: the default
# path is the one every session takes, and the one a new feature's author tends
# not to try.
#
# Usage: scripts/checks/agent-image-smoke.sh
#   AGENT_IMAGE=<ref>  use an already-built image instead of building one
#
# Needs a running Docker daemon.
set -u
set -o pipefail

# Git Bash on Windows rewrites /usr/local/bin/claude-style arguments into
# Windows paths; docker needs them untouched. No effect elsewhere.
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Host paths handed to docker must be native ones where the shell is MSYS.
native_path() {
	if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}
STUB="$(native_path "$REPO_ROOT/scripts/checks/fixtures/stub-claude.sh")"
IMAGE="${AGENT_IMAGE:-}"

fail() {
	echo "agent-image-smoke: FAIL: $*" >&2
	exit 1
}

if [ -z "$IMAGE" ]; then
	IMAGE="maskin-agent-base:smoke"
	echo "agent-image-smoke: building $IMAGE"
	docker build -q -t "$IMAGE" "$(native_path "$REPO_ROOT/docker/agent-base")" >/dev/null ||
		fail "image build failed"
fi

OUT=""
RC=0

# Runs one session. The entrypoint idles until /agent/.exec-trigger exists (the
# agent-server writes it in production), so create it first, then hand over to
# the real entrypoint. Extra args are passed to `docker run` (-e flags).
run_session() {
	OUT="$(
		timeout 180 docker run --rm \
			-v "$STUB:/usr/local/bin/claude:ro" \
			-e SESSION_ID=smoke \
			-e ACTION_PROMPT=smoke \
			"$@" \
			--entrypoint bash "$IMAGE" \
			-c 'touch /agent/.exec-trigger && exec /entrypoint.sh' 2>&1
	)"
	RC=$?
}

check() {
	local label="$1"
	shift
	run_session "$@"
	if [ "$RC" -ne 0 ] || ! grep -q "STUB_CLAUDE_RAN" <<<"$OUT"; then
		echo "$OUT" | tail -40 >&2
		fail "$label: session did not reach the agent launch (exit $RC)"
	fi
}

expect() {
	local label="$1" pattern="$2"
	grep -q -- "$pattern" <<<"$OUT" || {
		echo "$OUT" | tail -40 >&2
		fail "$label: output does not contain: $pattern"
	}
}

reject() {
	local label="$1" pattern="$2"
	if grep -q -- "$pattern" <<<"$OUT"; then
		echo "$OUT" | tail -40 >&2
		fail "$label: output unexpectedly contains: $pattern"
	fi
}

# Every claude_oauth session: no strip flag, a real base URL.
label="unflagged session"
check "$label" -e ANTHROPIC_BASE_URL=https://api.anthropic.com
expect "$label" "STUB_CLAUDE_RAN base_url=https://api.anthropic.com"
reject "$label" "strip-images proxy up"

label="bare environment"
check "$label"
expect "$label" "STUB_CLAUDE_RAN base_url=<unset>"

# maskin_plan on a text-only model: the proxy starts and the CLI is pointed at it.
label="text-only model"
check "$label" -e MASKIN_STRIP_IMAGES=1 -e ANTHROPIC_BASE_URL=https://openrouter.ai/api
expect "$label" "strip-images proxy up"
expect "$label" "STUB_CLAUDE_RAN base_url=http://127.0.0.1:9334"

# The flag without a base URL has nothing to proxy; it must not end the session.
label="strip flag without a base URL"
check "$label" -e MASKIN_STRIP_IMAGES=1
expect "$label" "STUB_CLAUDE_RAN base_url=<unset>"

# maskin_plan: low effort and no WebSearch reach the CLI as arguments.
label="maskin_plan effort and web search"
check "$label" -e MASKIN_CLAUDE_EFFORT=low -e MASKIN_DISABLE_WEB_SEARCH=1
expect "$label" "--effort low"
expect "$label" "--disallowedTools=WebSearch"

# Only the first-token guard set (no strip flag, no provider prefs): it still needs the proxy.
label="first-token guard only"
check "$label" -e MASKIN_TTFT_TIMEOUT_MS=5000 -e ANTHROPIC_BASE_URL=https://openrouter.ai/api
expect "$label" "strip-images proxy up"
expect "$label" "STUB_CLAUDE_RAN base_url=http://127.0.0.1:9334"

# The guard without a base URL has nothing to proxy; it must not end the session.
label="first-token guard without a base URL"
check "$label" -e MASKIN_TTFT_TIMEOUT_MS=5000
expect "$label" "STUB_CLAUDE_RAN base_url=<unset>"

# Neither set (every other route): the CLI gets neither argument.
label="no effort, web search on"
check "$label"
reject "$label" "--effort"
reject "$label" "--disallowedTools"

# Stdio tool servers: a stand-in third-party server (env) must see none of the Maskin
# or GitHub token variables, a server whose env block names one keeps exactly that
# one, and the http entry is left alone. The stub prints variable NAMES only.
MCP_CREDS=(-e MASKIN_API_KEY=canary-key -e MASKIN_API_URL=http://canary
	-e MASKIN_WORKSPACE_ID=canary-ws -e GITHUB_TOKEN=canary-gh -e GITHUB_TOKEN_ACME=canary-acme)
MCP_JSON='{"mcpServers":{"third-party":{"command":"env"},"named":{"command":"env","env":{"MASKIN_API_KEY":"${MASKIN_API_KEY}"}},"maskin-http":{"type":"http","url":"${MASKIN_API_URL}/mcp"}}}'

label="tool servers see only the variables they name"
check "$label" -e STUB_RUN_MCP_STDIO=1 "${MCP_CREDS[@]}" -e AGENT_MCP_JSON="$MCP_JSON"
expect "$label" "STUB_MCP_STDIO third-party sees: <none>"
expect "$label" "STUB_MCP_STDIO named sees: MASKIN_API_KEY "
reject "$label" "STUB_MCP_STDIO maskin-http"

# The rollback: with the scrub off the stand-in server inherits everything again.
# The switch itself is a MASKIN_* name in the container, so the server lists it too.
label="tool server scrub off"
check "$label" -e STUB_RUN_MCP_STDIO=1 -e MASKIN_MCP_ENV_SCRUB=off "${MCP_CREDS[@]}" \
	-e AGENT_MCP_JSON="$MCP_JSON"
expect "$label" "STUB_MCP_STDIO third-party sees: GITHUB_TOKEN GITHUB_TOKEN_ACME MASKIN_API_KEY MASKIN_API_URL MASKIN_MCP_ENV_SCRUB MASKIN_WORKSPACE_ID "

echo "agent-image-smoke: OK (10 sessions reached the agent launch)"
