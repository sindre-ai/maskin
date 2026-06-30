#!/bin/bash
# Integration test for setup_mcps dedup + setup_claude_credentials maskin-skip.
# Sources agent-run.sh (the entrypoint is guarded so the agent isn't launched),
# drives the two functions with fixtures, asserts the output.
#
# Run: bash docker/agent-base/__tests__/setup_mcps.test.sh
# Exits non-zero on the first failed assertion.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_RUN="$SCRIPT_DIR/../agent-run.sh"

if [ ! -f "$AGENT_RUN" ]; then
  echo "FAIL: cannot find agent-run.sh at $AGENT_RUN" >&2
  exit 1
fi

PASSES=0
FAILS=0

assert_eq() {
  if [ "$1" = "$2" ]; then
    echo "  ok: $3"
    PASSES=$((PASSES + 1))
  else
    echo "  FAIL: $3 (got '$1', expected '$2')" >&2
    FAILS=$((FAILS + 1))
  fi
}

assert_exists() {
  if [ -e "$1" ]; then
    echo "  ok: $2"
    PASSES=$((PASSES + 1))
  else
    echo "  FAIL: $2 (file '$1' missing)" >&2
    FAILS=$((FAILS + 1))
  fi
}

assert_not_exists() {
  if [ ! -e "$1" ]; then
    echo "  ok: $2"
    PASSES=$((PASSES + 1))
  else
    echo "  FAIL: $2 (file '$1' should not exist)" >&2
    FAILS=$((FAILS + 1))
  fi
}

# Isolate HOME so credentials.json writes don't pollute the real homedir.
TMPHOME="$(mktemp -d)"
cleanup() { rm -rf "$TMPHOME"; rm -f /tmp/mcp-config.json; }
trap cleanup EXIT

HOME="$TMPHOME"
export HOME

# Sourcing agent-run.sh installs its own EXIT trap (report_complete). That trap
# is a no-op when AGENT_SERVER_URL is unset, so it does not interfere with the
# test's own cleanup, but make sure the env stays clean.
unset AGENT_SERVER_URL SESSION_ID

# shellcheck source=/dev/null
. "$AGENT_RUN"

# ---- AC-T1: dedup duplicate Maskin registrations ----
echo "Test 1: AC-T1 — agent.tools and session both register Maskin → collapse to one"
unset AGENT_MCP_JSON MCP_SERVERS_JSON
MCP_CONFIG_FILE=""
rm -f /tmp/mcp-config.json

AGENT_MCP_JSON='{"mcpServers":{"maskin":{"type":"http","url":"https://maskin.io/mcp"}}}'
MCP_SERVERS_JSON='{"mcpServers":{"session-mcp-0":{"type":"http","url":"https://maskin.io/mcp"},"slack":{"type":"http","url":"https://slack.example/mcp"}}}'
export AGENT_MCP_JSON MCP_SERVERS_JSON

setup_mcps >/dev/null

assert_exists "/tmp/mcp-config.json" "mcp-config.json written"
server_count=$(jq '.mcpServers | length' /tmp/mcp-config.json)
assert_eq "$server_count" "2" "two entries after dedup (Maskin duplicate collapsed)"

maskin_url=$(jq -r '.mcpServers.maskin.url // empty' /tmp/mcp-config.json)
assert_eq "$maskin_url" "https://maskin.io/mcp" "agent.tools Maskin survives (higher precedence)"

dropped=$(jq -r '.mcpServers | has("session-mcp-0")' /tmp/mcp-config.json)
assert_eq "$dropped" "false" "session-mcp-0 (duplicate canonical tuple) dropped"

slack_url=$(jq -r '.mcpServers.slack.url // empty' /tmp/mcp-config.json)
assert_eq "$slack_url" "https://slack.example/mcp" "unique slack entry passes through"

# ---- AC-T1 (stdio variant): dedup by command+args ----
echo "Test 2: AC-T1 — stdio canonicalisation (command+args tuple)"
unset AGENT_MCP_JSON MCP_SERVERS_JSON
MCP_CONFIG_FILE=""
rm -f /tmp/mcp-config.json

AGENT_MCP_JSON='{"mcpServers":{"a":{"type":"stdio","command":"npx","args":["foo","bar"]}}}'
MCP_SERVERS_JSON='{"mcpServers":{"b":{"type":"stdio","command":"npx","args":["foo","bar"]},"c":{"type":"stdio","command":"npx","args":["baz"]}}}'
export AGENT_MCP_JSON MCP_SERVERS_JSON

setup_mcps >/dev/null

server_count=$(jq '.mcpServers | length' /tmp/mcp-config.json)
assert_eq "$server_count" "2" "stdio dedup: a==b collapsed, c kept"

a_kept=$(jq -r '.mcpServers | has("a")' /tmp/mcp-config.json)
b_dropped=$(jq -r '.mcpServers | has("b")' /tmp/mcp-config.json)
c_kept=$(jq -r '.mcpServers | has("c")' /tmp/mcp-config.json)
assert_eq "$a_kept" "true" "agent.tools entry a survives"
assert_eq "$b_dropped" "false" "session entry b dropped (same canonical)"
assert_eq "$c_kept" "true" "unique session entry c kept"

# ---- AC-T1: no-op when no MCP configs provided ----
echo "Test 3: setup_mcps no-op when both AGENT_MCP_JSON and MCP_SERVERS_JSON unset"
unset AGENT_MCP_JSON MCP_SERVERS_JSON
MCP_CONFIG_FILE=""
rm -f /tmp/mcp-config.json

setup_mcps >/dev/null
assert_not_exists "/tmp/mcp-config.json" "no config file written when no sources"
assert_eq "$MCP_CONFIG_FILE" "" "MCP_CONFIG_FILE left empty"

# ---- AC-T2: credentials write skipped when agent.tools.mcpServers.maskin is set ----
echo "Test 4: AC-T2 — credentials write skipped when agent.tools.mcpServers.maskin is set"
rm -rf "$TMPHOME/.claude"
AGENT_MCP_JSON='{"mcpServers":{"maskin":{"type":"http","url":"https://maskin.io/mcp"}}}'
CLAUDE_OAUTH_ACCESS_TOKEN="dummy-token"
CLAUDE_OAUTH_REFRESH_TOKEN="dummy-refresh"
CLAUDE_OAUTH_EXPIRES_AT="0"
CLAUDE_OAUTH_SCOPES="[]"
export AGENT_MCP_JSON CLAUDE_OAUTH_ACCESS_TOKEN CLAUDE_OAUTH_REFRESH_TOKEN CLAUDE_OAUTH_EXPIRES_AT CLAUDE_OAUTH_SCOPES

setup_claude_credentials >/dev/null
assert_not_exists "$TMPHOME/.claude/.credentials.json" \
  "credentials skipped when agent.tools.mcpServers.maskin set"

# ---- Human-driven session: no maskin in agent.tools → credentials still written ----
echo "Test 5: credentials write proceeds for human-driven sessions (no maskin in agent.tools)"
rm -rf "$TMPHOME/.claude"
unset AGENT_MCP_JSON
export CLAUDE_OAUTH_ACCESS_TOKEN

setup_claude_credentials >/dev/null
assert_exists "$TMPHOME/.claude/.credentials.json" \
  "credentials written when agent has no Maskin MCP"

token=$(jq -r '.claudeAiOauth.accessToken' "$TMPHOME/.claude/.credentials.json")
assert_eq "$token" "dummy-token" "credentials file carries the OAuth access token"

# ---- agent.tools without maskin key → credentials still written ----
echo "Test 6: agent.tools with other servers (no maskin key) → credentials still written"
rm -rf "$TMPHOME/.claude"
AGENT_MCP_JSON='{"mcpServers":{"slack":{"type":"http","url":"https://slack.example/mcp"}}}'
export AGENT_MCP_JSON

setup_claude_credentials >/dev/null
assert_exists "$TMPHOME/.claude/.credentials.json" \
  "credentials written when agent.tools has no maskin key"

echo
echo "Results: $PASSES passed, $FAILS failed"
[ "$FAILS" -eq 0 ]
