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

  # Append skills — each skill lives at /agent/skills/<name>/SKILL.md
  # (agent-storage.ts pullWorkspaceSkillsForAgent), not as a flat <name>.md.
  if [ -d /agent/skills ] && [ "$(ls -A /agent/skills/*/SKILL.md 2>/dev/null)" ]; then
    echo "## Skills" >> "$context_file"
    echo "" >> "$context_file"
    for f in /agent/skills/*/SKILL.md; do
      echo "### $(basename "$(dirname "$f")")" >> "$context_file"
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

CDP_RETRY_PROXY_PORT=9333

# Start a local retry proxy in front of the real CDP endpoint and repoint
# BROWSER_CDP_URL at it. @playwright/mcp's own CDP client gives up on a
# single ECONNRESET (see cdp-retry-proxy.js for the full rationale); this
# gives every CDP connection attempt from this session a few retries with
# backoff instead of failing the whole browser tool call on one transient
# guest<->host networking blip. Best-effort: if the proxy fails to start,
# BROWSER_CDP_URL is left pointing at the real endpoint directly.
setup_cdp_retry_proxy() {
  [ -z "$BROWSER_CDP_URL" ] && return
  local target_host target_port
  target_host="${BROWSER_CDP_URL#http://}"
  target_port="${target_host##*:}"
  target_host="${target_host%%:*}"
  if [ -z "$target_host" ] || [ -z "$target_port" ]; then
    echo "[system] WARNING: could not parse BROWSER_CDP_URL ($BROWSER_CDP_URL), skipping retry proxy" >&2
    return
  fi
  node /cdp-retry-proxy.js "$CDP_RETRY_PROXY_PORT" "$target_host" "$target_port" \
    > /tmp/cdp-retry-proxy.log 2>&1 &
  local proxy_pid=$!
  # Give it a moment to bind before handing out the local URL — a failed
  # bind (port in use, node missing) means BROWSER_CDP_URL should still
  # point at the real endpoint rather than a proxy that never came up.
  local deadline=$(( $(date +%s) + 3 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$proxy_pid" 2>/dev/null; then
      echo "[system] WARNING: cdp-retry-proxy exited immediately, using BROWSER_CDP_URL directly" >&2
      cat /tmp/cdp-retry-proxy.log >&2 2>/dev/null || true
      return
    fi
    grep -q "listening on" /tmp/cdp-retry-proxy.log 2>/dev/null && break
    sleep 0.2
  done
  if grep -q "listening on" /tmp/cdp-retry-proxy.log 2>/dev/null; then
    echo "[system] CDP retry proxy up, routing BROWSER_CDP_URL through 127.0.0.1:${CDP_RETRY_PROXY_PORT}"
    BROWSER_CDP_URL="http://127.0.0.1:${CDP_RETRY_PROXY_PORT}"
  else
    echo "[system] WARNING: cdp-retry-proxy did not confirm startup, using BROWSER_CDP_URL directly" >&2
  fi
}

setup_mcps() {
  # Skip if no MCP config provided and no browser CDP endpoint
  if [ -z "$AGENT_MCP_JSON" ] && [ -z "$MCP_SERVERS_JSON" ] && [ -z "$BROWSER_CDP_URL" ]; then
    return
  fi

  setup_cdp_retry_proxy

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

# Start the guest-side watcher that auto-relays dev-server ports the agent
# starts on its own (see preview-port-watcher.js and POST
# /sessions/:id/preview-ports in apps/agent-server). Only meaningful when
# there's a browser sidecar to relay into (BROWSER_CDP_URL set) and a live
# agent-server to call back into (AGENT_SERVER_URL resolved above,
# SESSION_ID set) — a no-op session (local Docker path, no browser) skips
# this entirely. Best-effort: failure to start just means auto-relay isn't
# available this session, same posture as the CDP retry proxy above.
start_preview_port_watcher() {
  if [ -z "$BROWSER_CDP_URL" ] || [ -z "$AGENT_SERVER_URL" ] || [ -z "$SESSION_ID" ]; then
    return
  fi
  node /preview-port-watcher.js > /tmp/preview-port-watcher.log 2>&1 &
  echo "[system] preview-port watcher started (pid $!)"
}

# Run the agent
run_agent() {
  # Agent output leaves the VM over HTTP: bind mounts from the microVM to the
  # host are not reliable in the current microsandbox version. output-stream.js
  # reads AGENT_SERVER_URL/SESSION_ID from the environment itself.
  #
  # Ship agent output to the agent-server via output-stream.js, which POSTs it
  # in bounded, acknowledged batches. It replaced a single long-lived chunked
  # upload (curl -T -) that could not survive microsandbox egress proxy: when
  # the proxy guest-side leg died the upload never EOFed and never errored, so
  # curl blocked in a write forever and the reconnect loop around it could not
  # run. The agent reply then never left the VM -- the user saw silence even
  # though the agent had answered (wedges of Aug 21-24), and with the reader
  # stalled the pipe eventually blocked the agent itself.
  #
  # The helper drains stdin unconditionally, so delivery can never apply
  # backpressure to the agent, and only forgets lines the server acks. With no
  # AGENT_SERVER_URL (the local Docker path) it just passes stdin to stdout.
  # See docker/agent-base/output-stream.js.
  # `|| true` because this is a log shipper, not the agent. Line 2 sets
  # `set -e`, and every call site turns pipefail OFF before `agent | log_tee`,
  # so the pipeline's status is THIS command's. A non-zero exit here therefore
  # aborted run_agent before `AGENT_EXIT_CODE=${PIPESTATUS[0]}` ran, and the
  # EXIT trap reported the initial 0 — a failed session posting clean success,
  # with everything after run_agent skipped.
  #
  # It must be inside this function, not `... | log_tee || true` at the call
  # site: `|| true` there resets PIPESTATUS, so ${PIPESTATUS[0]} reads 0 and
  # every real agent failure is masked as success. Verified both ways.
  # PIPESTATUS[0] refers to the agent, the pipeline's FIRST element, so
  # swallowing this function's own status cannot affect it.
  log_tee() {
    node /output-stream.js || true
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
          # input-stream.js holds the connection and pipes NDJSON turns into
          # claude stdin via process substitution, so no Docker stdin attach
          # is needed. It replaced a curl reconnect loop that could not work:
          # these connections terminate on the HOST at microsandbox's egress
          # proxy, and when the proxy guest-side leg dies the host keeps
          # ACKing writes into a socket the guest never reads. Host-side the
          # socket looks perfect (Send-Q 0, bytes_sent == bytes_acked); in the
          # guest curl blocked forever on a half-open socket that never EOFs
          # and never errors, so the loop around it never ran and every turn
          # the human sent was silently destroyed (wedges of Aug 21-24).
          #
          # The helper fixes both halves: it re-dials when no byte arrives for
          # 90s (three missed server heartbeats), and it acks the seq of each
          # turn it consumed so the agent-server can redeliver anything a
          # blackholed write swallowed. See docker/agent-base/input-stream.js
          # and apps/agent-server/src/services/input-queue.ts.
          #
          # Its stdout IS claude stdin, so it carries only NDJSON turns;
          # status and errors go to stderr. It never exits on its own -- it
          # dies with the VM at teardown -- so claude stdin never sees EOF
          # mid-conversation.
          set +o pipefail
          claude -p \
            --input-format stream-json \
            --output-format stream-json \
            --verbose \
            --dangerously-skip-permissions \
            "${mcp_args[@]}" \
            2>&1 \
            < <(node /input-stream.js) \
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
start_preview_port_watcher

run_agent
