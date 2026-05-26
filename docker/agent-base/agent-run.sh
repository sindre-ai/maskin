#!/bin/bash
set -e

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

# Resolve host.docker.internal → host-gateway IP. Chrome 132+ rejects DevTools
# WebSocket upgrades unless the Host header is an IP or "localhost" — connecting
# via the hostname trips that DNS-rebinding defense and 500s. We substitute the
# IP into BROWSER_CDP_URL and the MCP config so the agent dials by IP, which
# Chrome accepts as the Host value.
resolve_host_docker_internal() {
  local ip
  ip=$(getent hosts host.docker.internal 2>/dev/null | awk '{ print $1 }' | head -1)
  if [ -n "$ip" ]; then
    echo "$ip"
  fi
}

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

  # Rewrite host.docker.internal → IP. Required by Chrome's DevTools Host header
  # check; harmless for non-CDP servers since the substitution still reaches the
  # same Docker host gateway.
  local host_ip
  host_ip=$(resolve_host_docker_internal)
  if [ -n "$host_ip" ]; then
    merged=$(echo "$merged" | sed "s|host.docker.internal|$host_ip|g")
  fi

  # Only write if there are actual servers configured
  local server_count
  server_count=$(echo "$merged" | jq '.mcpServers | length')
  if [ "$server_count" -gt 0 ]; then
    # ${VAR} placeholders were already expanded by the session manager before
    # the JSON was serialized — text-level envsubst here would corrupt JSON for
    # values containing ", $, or backticks (e.g. LinkedIn cookie's quoted
    # JSESSIONID). Just write the config as-is.
    echo "$merged" > "$mcp_config"
    MCP_CONFIG_FILE="$mcp_config"
    echo "[system] MCP servers configured ($server_count servers)"
    if [ -n "$host_ip" ]; then
      echo "[system] Resolved host.docker.internal → $host_ip for CDP Host header"
    fi
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
      local mcp_args=()
      if [ -n "$MCP_CONFIG_FILE" ]; then
        mcp_args=(--mcp-config "$MCP_CONFIG_FILE")
      fi
      if [ "$INTERACTIVE" = "1" ]; then
        exec claude -p \
          --input-format stream-json \
          --output-format stream-json \
          --verbose \
          --dangerously-skip-permissions \
          "${mcp_args[@]}" \
          2>&1
      fi
      exec claude -p "$ACTION_PROMPT" \
        --print \
        --verbose \
        --output-format stream-json \
        --max-turns "$max_turns" \
        --dangerously-skip-permissions \
        "${mcp_args[@]}" \
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
      if echo "$CUSTOM_COMMAND" | grep -qE '[;&|`$(){}<>*?!\\"'"'"']'; then
        echo "[error] CUSTOM_COMMAND contains forbidden shell characters" >&2
        exit 1
      fi
      # Split on whitespace into an array, then exec without a shell —
      # no word splitting surprises, no glob expansion, no interpolation.
      read -r -a custom_argv <<< "$CUSTOM_COMMAND"
      if [ "${#custom_argv[@]}" -eq 0 ]; then
        echo "[error] CUSTOM_COMMAND is empty after tokenization" >&2
        exit 1
      fi
      exec "${custom_argv[@]}" 2>&1
      ;;
  esac
}

echo "[system] Starting agent session: ${SESSION_ID:-unknown}"
echo "[system] Runtime: $RUNTIME"

install_runtime
build_context

# Substitute host.docker.internal → host-gateway IP in BROWSER_CDP_URL too, so
# any MCP server that reads it directly from the env (rather than from the
# resolved mcp-config.json) also gets a Chrome-acceptable Host header.
if [ -n "$BROWSER_CDP_URL" ] && [[ "$BROWSER_CDP_URL" == *host.docker.internal* ]]; then
  _host_ip=$(getent hosts host.docker.internal 2>/dev/null | awk '{ print $1 }' | head -1)
  if [ -n "$_host_ip" ]; then
    export BROWSER_CDP_URL="${BROWSER_CDP_URL//host.docker.internal/$_host_ip}"
  fi
fi

setup_mcps
setup_claude_credentials

run_agent
