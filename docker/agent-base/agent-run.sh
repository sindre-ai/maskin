#!/bin/bash
set -e

# Source overflow env vars (microsandbox has a ~1500 char limit per env var,
# so large values are written to a file by the runtime backend).
if [ -f /agent/.env-overflow.sh ]; then
  # shellcheck disable=SC1091
  source /agent/.env-overflow.sh
fi

RUNTIME="${AGENT_RUNTIME:-claude-code}"

# Install runtime if not already present
install_runtime() {
  case "$RUNTIME" in
    claude-code)
      if ! command -v claude &> /dev/null; then
        echo "[system] Installing Claude Code CLI..."
        npm install -g @anthropic-ai/claude-code 2>&1
      fi
      ;;
    codex)
      if ! command -v codex &> /dev/null; then
        echo "[system] Installing OpenAI Codex CLI..."
        npm install -g @openai/codex 2>&1
      fi
      ;;
    custom)
      echo "[system] Using custom runtime command"
      ;;
    *)
      echo "[error] Unknown runtime: $RUNTIME" >&2
      exit 1
      ;;
  esac
}

# Build CLAUDE.md from system prompt + skills
build_context() {
  local context_file="/agent/workspace/CLAUDE.md"

  if [ -n "$SYSTEM_PROMPT" ]; then
    echo "$SYSTEM_PROMPT" > "$context_file"
    echo "" >> "$context_file"
  fi

  # Append skills
  if [ -d /agent/skills ] && [ "$(ls -A /agent/skills/*.md 2>/dev/null)" ]; then
    echo "## Skills" >> "$context_file"
    echo "" >> "$context_file"
    for f in /agent/skills/*.md; do
      echo "### $(basename "$f" .md)" >> "$context_file"
      echo "" >> "$context_file"
      cat "$f" >> "$context_file"
      echo "" >> "$context_file"
    done
  fi

  # Append memory/learnings
  if [ -f /agent/memory/consolidated-learnings.md ]; then
    echo "## Learnings" >> "$context_file"
    echo "" >> "$context_file"
    cat /agent/memory/consolidated-learnings.md >> "$context_file"
    echo "" >> "$context_file"
  fi

  echo "[system] Context file written to $context_file"
}

# Configure MCP servers — writes config file and sets MCP_CONFIG_FILE for run_agent
MCP_CONFIG_FILE=""

setup_mcps() {
  # Skip if no MCP config provided
  if [ -z "$AGENT_MCP_JSON" ] && [ -z "$MCP_SERVERS_JSON" ]; then
    return
  fi

  local mcp_config="/tmp/mcp-config.json"
  local empty='{}'
  local agent_config="${AGENT_MCP_JSON:-$empty}"
  local session_config="${MCP_SERVERS_JSON:-$empty}"

  # Merge agent + session MCP configs (session overrides agent for same-named servers)
  local merged
  merged=$(printf '%s\n%s' "$agent_config" "$session_config" | jq -s '
    { mcpServers: ((.[0].mcpServers // {}) * (.[1].mcpServers // {})) }
  ')

  # Only write if there are actual servers configured
  local server_count
  server_count=$(echo "$merged" | jq '.mcpServers | length')
  if [ "$server_count" -gt 0 ]; then
    # Expand env var references (e.g. ${MASKIN_API_URL}, ${MASKIN_API_KEY})
    echo "$merged" | envsubst > "$mcp_config"
    MCP_CONFIG_FILE="$mcp_config"
    echo "[system] MCP servers configured ($server_count servers)"
  fi
}

# Write Claude OAuth credentials file if OAuth tokens are provided.
# Claude Code reads auth from ~/.claude/.credentials.json, not env vars.
setup_claude_credentials() {
  if [ -z "$CLAUDE_OAUTH_ACCESS_TOKEN" ]; then
    return
  fi

  local creds_dir="$HOME/.claude"
  mkdir -p "$creds_dir"

  local scopes="${CLAUDE_OAUTH_SCOPES:-[]}"
  local sub_type="${CLAUDE_OAUTH_SUBSCRIPTION_TYPE:-}"
  local expires_at="${CLAUDE_OAUTH_EXPIRES_AT:-0}"

  # Build the subscription/rateLimitTier fields
  local sub_fields=""
  if [ -n "$sub_type" ]; then
    sub_fields="\"subscriptionType\":\"$sub_type\","
  fi

  cat > "$creds_dir/.credentials.json" <<CREDS_EOF
{
  "claudeAiOauth": {
    "accessToken": "$CLAUDE_OAUTH_ACCESS_TOKEN",
    "refreshToken": "$CLAUDE_OAUTH_REFRESH_TOKEN",
    "expiresAt": $expires_at,
    ${sub_fields}
    "scopes": $scopes
  }
}
CREDS_EOF

  echo "[system] Claude OAuth credentials written to $creds_dir/.credentials.json"
}

# Run the agent
run_agent() {
  case "$RUNTIME" in
    claude-code)
      local max_turns="${MAX_TURNS:-5000}"
      local mcp_args=""
      if [ -n "$MCP_CONFIG_FILE" ]; then
        mcp_args="--mcp-config $MCP_CONFIG_FILE"
      fi
      exec claude -p "$ACTION_PROMPT" \
        --print \
        --verbose \
        --output-format stream-json \
        --max-turns "$max_turns" \
        --dangerously-skip-permissions \
        $mcp_args \
        2>&1
      ;;
    codex)
      local approval_mode="${CODEX_APPROVAL_MODE:-full-auto}"
      exec codex \
        --approval-mode "$approval_mode" \
        --prompt "$ACTION_PROMPT" \
        2>&1
      ;;
    custom)
      if [ -z "$CUSTOM_COMMAND" ]; then
        echo "[error] CUSTOM_COMMAND is required for custom runtime" >&2
        exit 1
      fi
      # Reject shell metacharacters to prevent command injection
      if echo "$CUSTOM_COMMAND" | grep -qE '[;&|`$(){}]'; then
        echo "[error] CUSTOM_COMMAND contains forbidden shell characters" >&2
        exit 1
      fi
      # Use exec without eval — word splitting only, no shell interpretation
      exec $CUSTOM_COMMAND 2>&1
      ;;
  esac
}

echo "[system] Starting agent session: ${SESSION_ID:-unknown}"
echo "[system] Runtime: $RUNTIME"

install_runtime
build_context
setup_mcps
setup_claude_credentials

run_agent
