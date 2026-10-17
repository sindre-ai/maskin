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
# It also covers the BYO guard wrapper (maskin-mcp-guard). The API rewrites each
# custom-extension MCP server to run behind it, and agent-run.sh must fail closed:
# a guarded server is dropped, and logged, on an image where the wrapper is
# missing or does not run. It is never started without the wrapper.
#
# Usage: scripts/checks/agent-image-smoke.sh
#   AGENT_IMAGE=<ref>     use an already-built image instead of building one
#   PREVIOUS_IMAGE=<ref>  also check this image (the one currently deployed, for
#                         example <repo>:latest before a merge): a guarded server
#                         must not be startable on it unless it carries the wrapper
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
STUB_GUARD="$(native_path "$REPO_ROOT/scripts/checks/fixtures/stub-guard.sh")"
STUB_GUARD_BROKEN="$(native_path "$REPO_ROOT/scripts/checks/fixtures/stub-guard-broken.sh")"
IMAGE="${AGENT_IMAGE:-}"
PREVIOUS_IMAGE="${PREVIOUS_IMAGE:-}"
SESSION_IMAGE=""
SESSIONS=0

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
			--entrypoint bash "${SESSION_IMAGE:-$IMAGE}" \
			-c 'touch /agent/.exec-trigger && exec /entrypoint.sh' 2>&1
	)"
	RC=$?
	SESSIONS=$((SESSIONS + 1))
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

# Neither set (every other route): the CLI gets neither argument.
label="no effort, web search on"
check "$label"
reject "$label" "--effort"
reject "$label" "--disallowedTools"

# --- Guard wrapper (maskin-mcp-guard) ----------------------------------------
# One guarded server (the shape the API writes: wrapper first, real command
# after `--`) next to one plain server and one URL server. Servers are listed
# sorted by name by the stub, so the expected lists are alphabetical.
GUARD_MCP='{"mcpServers":{"ext-guarded":{"command":"maskin-mcp-guard","args":["--","npx","fake-mcp"]},"plain":{"command":"npx","args":["fake-mcp"]},"remote":{"url":"https://example.invalid/mcp"}}}'
GUARD_PATH="/usr/local/bin/maskin-mcp-guard"

# No MCP config: the version line is still logged at session start.
label="guard version line without MCP config"
check "$label" -v "$STUB_GUARD:$GUARD_PATH:ro"
expect "$label" "maskin-mcp-guard version: 0.0.0-stub"
expect "$label" "STUB_MCP_SERVERS=<none>"

# Wrapper present and answering --version: the guarded server is kept.
label="guard present"
check "$label" -v "$STUB_GUARD:$GUARD_PATH:ro" -e "MCP_SERVERS_JSON=$GUARD_MCP"
expect "$label" "maskin-mcp-guard version: 0.0.0-stub"
expect "$label" "STUB_MCP_SERVERS=ext-guarded,plain,remote"
expect "$label" "STUB_MCP_STARTABLE=ext-guarded,plain"
reject "$label" "dropped"

# Wrapper on the PATH but unable to run: dropped, logged, others untouched.
label="guard present but broken"
check "$label" -v "$STUB_GUARD_BROKEN:$GUARD_PATH:ro" -e "MCP_SERVERS_JSON=$GUARD_MCP"
expect "$label" "MCP server 'ext-guarded' dropped"
expect "$label" "STUB_MCP_SERVERS=plain,remote"
reject "$label" "ext-guarded,"

# Wrapper file not executable (an empty, non-executable file over the path).
label="guard not executable"
check "$label" -v "/dev/null:$GUARD_PATH:ro" -e "MCP_SERVERS_JSON=$GUARD_MCP"
expect "$label" "maskin-mcp-guard not available in this image"
expect "$label" "MCP server 'ext-guarded' dropped"
expect "$label" "STUB_MCP_SERVERS=plain,remote"

# The image as built, with no overlay. Whichever way it was built, the guarded
# server is either kept because the wrapper really runs here, or dropped because
# it does not. It is never kept without a working wrapper.
if docker run --rm --entrypoint bash "$IMAGE" -c 'maskin-mcp-guard --version' >/dev/null 2>&1; then
	label="image wrapper (present)"
	check "$label" -e "MCP_SERVERS_JSON=$GUARD_MCP"
	expect "$label" "maskin-mcp-guard version: "
	expect "$label" "STUB_MCP_SERVERS=ext-guarded,plain,remote"
	reject "$label" "dropped"
	echo "agent-image-smoke: image carries a working maskin-mcp-guard"
else
	label="image wrapper (absent)"
	check "$label" -e "MCP_SERVERS_JSON=$GUARD_MCP"
	expect "$label" "maskin-mcp-guard not available in this image"
	expect "$label" "MCP server 'ext-guarded' dropped"
	expect "$label" "STUB_MCP_SERVERS=plain,remote"
	echo "agent-image-smoke: image has no maskin-mcp-guard; guarded servers are dropped"
fi

# The previously deployed image: the one the guarded launch meets if the image
# and the launch change ever land in the wrong order. Its agent-run.sh predates
# the fail-closed drop, so the guarded entry stays in its config, and what must
# hold is that it cannot start: no maskin-mcp-guard, so nothing runs for it, and
# nothing that was wrapped is started unwrapped under another entry.
if [ -n "$PREVIOUS_IMAGE" ]; then
	SESSION_IMAGE="$PREVIOUS_IMAGE"
	if docker run --rm --entrypoint bash "$PREVIOUS_IMAGE" -c 'maskin-mcp-guard --version' >/dev/null 2>&1; then
		label="previous image (carries the wrapper)"
		check "$label" -e "MCP_SERVERS_JSON=$GUARD_MCP"
		expect "$label" "maskin-mcp-guard version: "
		expect "$label" "STUB_MCP_STARTABLE=ext-guarded,plain"
		echo "agent-image-smoke: previous image $PREVIOUS_IMAGE already carries the wrapper"
	else
		label="previous image (no wrapper)"
		check "$label" -e "MCP_SERVERS_JSON=$GUARD_MCP"
		expect "$label" "STUB_MCP_STARTABLE=plain"
		reject "$label" "STUB_MCP_STARTABLE=.*ext-guarded"
		echo "agent-image-smoke: previous image $PREVIOUS_IMAGE has no wrapper; the guarded server cannot start"
	fi
	SESSION_IMAGE=""
fi

echo "agent-image-smoke: OK ($SESSIONS sessions reached the agent launch)"
