#!/bin/bash
set -eo pipefail

# Source overflow env vars (values >1500 chars spilled here by the agent-server)
if [ -f /agent/.env-overflow.sh ]; then
  # shellcheck source=/dev/null
  source /agent/.env-overflow.sh
fi

# Resolve a working URL for the agent-server (log ingest, input stream, completion
# signal). The server injects AGENT_SERVER_URL as http://host.microsandbox.internal:<port>,
# but on msb 0.5.7 that alias does not reliably resolve inside the VM, so every
# VM->host call silently fails (this is why logs never appeared and the completion
# signal never arrived). microsandbox routes the VM to the host via the per-sandbox
# gateway IP — the nameserver in /etc/resolv.conf — which msb rewrites to the host
# loopback. We probe the gateway IP first, then the injected alias, and keep the
# first candidate that actually answers /health. Forcing IPv4 avoids the IPv6
# happy-eyeballs path (the agent-server listens on 0.0.0.0 only). If nothing
# answers, AGENT_SERVER_URL is left unchanged (calls stay best-effort no-ops).
resolve_agent_server_url() {
  [ -z "$AGENT_SERVER_URL" ] && return
  local port gw cand deadline
  port="${AGENT_SERVER_URL##*:}"
  # /etc/resolv.conf is populated by microsandbox a few seconds after VM boot;
  # the create-time entrypoint runs before it's ready, so spin until it appears
  # (up to 15s) rather than falling through to the unreliable host alias.
  deadline=$(( $(date +%s) + 15 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    gw="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf 2>/dev/null)"
    [ -n "$gw" ] && break
    sleep 1
  done
  for cand in ${gw:+"http://${gw}:${port}"} "$AGENT_SERVER_URL"; do
    if curl -4 -s -m 4 -o /dev/null "${cand}/health" 2>/dev/null; then
      AGENT_SERVER_URL="$cand"
      echo "[system] agent-server reachable at ${cand}"
      return
    fi
  done
  echo "[system] WARNING: agent-server not reachable from VM (tried gateway + alias)" >&2
}
resolve_agent_server_url

# Signal session completion so the agent-server tears down this microVM.
# A microsandbox `create`d VM is PERSISTENT: it does NOT power off when this
# script exits, because the guest's PID 1 is microsandbox's agentd, not us.
# Without this signal the sandbox sits "running" until the server's max-duration
# backstop fires (hours). The EXIT trap fires on normal completion, on `set -e`
# failure, and on most signals, so teardown is tied to the workload ending.
# Best-effort; --http1.0/--max-time stop a slow ingest from blocking VM exit.
# Only meaningful on the remote microsandbox path (AGENT_SERVER_URL set); the
# local Docker path manages container lifecycle itself.
report_complete() {
  if [ -n "$AGENT_SERVER_URL" ] && [ -n "$SESSION_ID" ]; then
    curl -4 -s --http1.0 --max-time 10 -X POST \
      "${AGENT_SERVER_URL}/sessions/${SESSION_ID}/complete" \
      -H "Content-Type: application/json" \
      -d "{\"exitCode\":${AGENT_EXIT_CODE}}" \
      -o /dev/null 2>/dev/null || true
  fi
}
trap report_complete EXIT

RUNTIME="${AGENT_RUNTIME:-claude-code}"
AGENT_EXIT_CODE=0

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
  # Skip if no MCP config provided and no browser CDP endpoint
  if [ -z "$AGENT_MCP_JSON" ] && [ -z "$MCP_SERVERS_JSON" ] && [ -z "$BROWSER_CDP_URL" ]; then
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

  # Handle the browser CDP endpoint.
  #
  # The actor's MCP config may reference ${BROWSER_CDP_URL} as a literal
  # placeholder (e.g. Playwright MCP configured with --cdp-endpoint
  # "${BROWSER_CDP_URL}"). envsubst at the end of this function expands it.
  #
  # Two cases:
  #   1. BROWSER_CDP_URL is SET: if the merged config already references the
  #      literal placeholder, envsubst handles it — no extra entry needed.
  #      If no existing entry uses it, inject a default @playwright/mcp entry
  #      so the browser is reachable even without a pre-configured actor MCP.
  #   2. BROWSER_CDP_URL is UNSET: strip any entry that still contains the
  #      literal ${BROWSER_CDP_URL} placeholder. Without this, envsubst would
  #      expand it to an empty string, causing Playwright to try to launch
  #      Chrome locally instead of connecting to the CDP endpoint.
  if [ -n "$BROWSER_CDP_URL" ]; then
    if ! echo "$merged" | jq -e '[.mcpServers | to_entries[] | .value | tostring] | any(contains("${BROWSER_CDP_URL}"))' > /dev/null 2>&1; then
      local browser_entry
      browser_entry=$(jq -n --arg url "$BROWSER_CDP_URL" \
        '{"mcpServers":{"@playwright/mcp":{"command":"npx","args":["@playwright/mcp","--cdp-endpoint",$url]}}}')
      merged=$(echo "$merged" "$browser_entry" | jq -s '{ mcpServers: ((.[0].mcpServers // {}) * (.[1].mcpServers // {})) }')
    fi
  else
    merged=$(echo "$merged" | jq '
      .mcpServers = (.mcpServers | with_entries(
        select((.value | tostring | contains("${BROWSER_CDP_URL}")) | not)
      ))
    ')
  fi

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

# Point git's github.com credential helper at our just-in-time token script
# instead of relying on GITHUB_TOKEN staying valid for the whole session.
# GitHub App installation tokens expire after exactly 1 hour, so a session
# running longer than that would otherwise start failing git push/fetch/clone
# partway through. Skipped entirely if no GitHub integration is configured
# (GITHUB_INTEGRATION_ID unset), same as the GITHUB_TOKEN injection it backs.
setup_github_credential_helper() {
  if [ -z "$GITHUB_INTEGRATION_ID" ]; then
    return
  fi

  # Reset any pre-existing helper chain for this host so ours is authoritative,
  # then add ours. An empty value clears the list per git-credential(1).
  git config --global credential."https://github.com".helper ""
  git config --global --add credential."https://github.com".helper "/agent-github-credential-helper.sh"

  echo "[system] GitHub credential helper configured for github.com"
}

# Run the agent
run_agent() {
  # Pipe output to the agent-server's log ingest endpoint so the Maskin UI
  # can show live logs. Bind mounts from the microVM to the host are not
  # reliable in the current microsandbox version, so we stream over HTTP
  # instead. Falls back to plain stdout if AGENT_SERVER_URL is unset.
  local log_ingest_url=""
  if [ -n "$AGENT_SERVER_URL" ] && [ -n "$SESSION_ID" ]; then
    log_ingest_url="${AGENT_SERVER_URL}/sessions/${SESSION_ID}/logs/ingest"
  fi

  # Stream agent output to the agent-server's log-ingest endpoint LINE BY LINE
  # over a single long-lived chunked POST, so the Maskin UI shows logs live
  # while the agent runs.  The previous implementation buffered ALL output to a
  # temp file (`cat > file`) and POSTed it once at exit (`--data-binary @file`),
  # which (a) showed nothing until the process exited and (b) showed NOTHING for
  # interactive sessions, where `claude` never exits.
  log_tee() {
    if [ -z "$log_ingest_url" ]; then
      # No agent-server reachable: just drain stdin (to the unread PTY) so the
      # agent isn't blocked by a full pipe.
      cat
      return
    fi
    # `curl -T -` uploads stdin with Transfer-Encoding: chunked, forwarding bytes
    # as they arrive — unlike `--data-binary @-`, which first buffers ALL of
    # stdin to compute a Content-Length (effectively what `cat > file` did).
    # Chunked requires HTTP/1.1, so we drop the old `--http1.0`.  The server
    # (apps/agent-server) reads the request body as a stream and pushes each
    # newline-delimited line into the session's log buffer immediately, so one
    # POST carries the whole session and the UI updates as lines arrive.
    # `-H "Expect:"` strips the 100-continue handshake (curl adds it for uploads
    # >1KB), which would otherwise stall the stream waiting for a 100 Continue.
    #
    # Why a function fed by a pipe (`agent ... | log_tee`) and not process
    # substitution: bash WAITS for every stage of a pipeline before the script
    # exits, so curl finishes before run_agent returns and the VM is torn down.
    # bash does NOT wait for `>(...)` subprocesses (the reason the old code could
    # not use them).  curl also continuously drains the pipe, so the undrained
    # microsandbox PTY never fills and freezes the agent — the problem that ruled
    # out plain `tee`.
    #
    # The reconnect loop keeps a reader on the pipe AT ALL TIMES.  Without it a
    # dropped upload connection would leave the agent writing to a broken pipe
    # (SIGPIPE -> the agent dies).  With it, a transient drop reconnects and
    # resumes streaming; after repeated failures we fall back to draining stdin
    # so the agent keeps running and this script can still reach its EXIT trap
    # (the completion signal).  curl returns 0 only once stdin hits EOF (the
    # agent exited) and the body flushed — the clean end-of-stream.
    local attempts=0
    while true; do
      if curl -4 -sN -X POST "$log_ingest_url" \
          -H "Content-Type: text/plain" \
          -H "Expect:" \
          -T - \
          -o /dev/null \
          2>/dev/null; then
        return 0
      fi
      attempts=$((attempts + 1))
      if [ "$attempts" -ge 5 ]; then
        cat > /dev/null
        return 0
      fi
      sleep 1
    done
  }

  case "$RUNTIME" in
    claude-code)
      local max_turns="${MAX_TURNS:-5000}"
      local mcp_args=()
      if [ -n "$MCP_CONFIG_FILE" ]; then
        mcp_args=(--mcp-config "$MCP_CONFIG_FILE")
      fi
      if [ "$INTERACTIVE" = "1" ]; then
        if [ -n "$AGENT_SERVER_URL" ]; then
          # Remote microsandbox path: stream user turns from the agent-server.
          # curl holds a long-lived HTTP connection; process substitution pipes
          # its output into claude's stdin so each newline-delimited JSON message
          # is delivered as a user turn without needing Docker stdin attach.
          set +o pipefail
          claude -p \
            --input-format stream-json \
            --output-format stream-json \
            --verbose \
            --dangerously-skip-permissions \
            "${mcp_args[@]}" \
            2>&1 \
            < <(curl -4 -sN --no-buffer \
                "${AGENT_SERVER_URL}/sessions/${SESSION_ID}/input/stream") \
            | log_tee
          AGENT_EXIT_CODE=${PIPESTATUS[0]}
          set -o pipefail
        else
          # Local Docker path: stdin is attached by ContainerManager.attachStdin.
          set +o pipefail
          claude -p \
            --input-format stream-json \
            --output-format stream-json \
            --verbose \
            --dangerously-skip-permissions \
            "${mcp_args[@]}" \
            2>&1 | log_tee
          AGENT_EXIT_CODE=${PIPESTATUS[0]}
          set -o pipefail
        fi
      else
        set +o pipefail
        claude -p "$ACTION_PROMPT" \
          --print \
          --verbose \
          --output-format stream-json \
          --max-turns "$max_turns" \
          --dangerously-skip-permissions \
          "${mcp_args[@]}" \
          2>&1 | log_tee
        AGENT_EXIT_CODE=${PIPESTATUS[0]}
        set -o pipefail
      fi
      ;;
    codex)
      local approval_mode="${CODEX_APPROVAL_MODE:-full-auto}"
      set +o pipefail
      codex \
        --approval-mode "$approval_mode" \
        --prompt "$ACTION_PROMPT" \
        2>&1 | log_tee
      AGENT_EXIT_CODE=${PIPESTATUS[0]}
      set -o pipefail
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
      set +o pipefail
      "${custom_argv[@]}" 2>&1 | log_tee
      AGENT_EXIT_CODE=${PIPESTATUS[0]}
      set -o pipefail
      ;;
  esac
}

echo "[system] Starting agent session: ${SESSION_ID:-unknown}"
echo "[system] Runtime: $RUNTIME"

install_runtime
build_context
setup_mcps
setup_claude_credentials
setup_github_credential_helper

run_agent
