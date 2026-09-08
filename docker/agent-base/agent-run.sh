#!/bin/bash
set -eo pipefail

# Source overflow env vars (values >1500 chars spilled here by the agent-server)
if [ -f /agent/.env-overflow.sh ]; then
  # shellcheck source=/dev/null
  source /agent/.env-overflow.sh
fi

# Committer identity for anything the agent commits. Overridable via env, but
# any override must stay on a domain we own (maskin.io / sindre.ai) — see
# setup_git_identity below.
GIT_IDENTITY_NAME="${GIT_IDENTITY_NAME:-Maskin Agent}"
GIT_IDENTITY_EMAIL="${GIT_IDENTITY_EMAIL:-agent@maskin.io}"

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
  # MUST be the first statement: $? is this script's exit status.
  local script_rc=$?
  # If run_agent never captured a real agent status (the agent was killed
  # before `wait` returned, install_runtime failed, `set -e` aborted us, ...)
  # then AGENT_EXIT_CODE is still its initial 0 and reporting it would post a
  # clean success for a session that failed. Fall back to the script's own
  # status, which is non-zero in exactly those cases.
  if [ "$AGENT_EXIT_CODE_CAPTURED" != "1" ]; then
    AGENT_EXIT_CODE=$script_rc
  fi
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
# Set to 1 only once `wait` has returned the agent's real status. Until then
# AGENT_EXIT_CODE is a placeholder and report_complete must not trust it.
AGENT_EXIT_CODE_CAPTURED=0
# How long to let the log shipper drain after the agent exits, before reaping
# it. Only reached when something still holds the output fd open (see
# run_agent_logged); a clean exit EOFs immediately and never waits.
LOG_DRAIN_GRACE_SECS="${LOG_DRAIN_GRACE_SECS:-15}"

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
  # tee, not a plain redirect: the startup poll below greps this log file,
  # so the file must stay - but it lives in a VM that gets destroyed, so it
  # is also mirrored to stderr, which `msb exec` carries back to the host
  # and into agent-server logs as source='msb-exec' (guest-log-stream.ts).
  # Process substitution (not a pipeline) keeps $! as node's own pid, which
  # the kill -0 liveness check below depends on.
  node /cdp-retry-proxy.js "$CDP_RETRY_PROXY_PORT" "$target_host" "$target_port" \
    > >(tee /tmp/cdp-retry-proxy.log | sed -u 's/^/[cdp-retry-proxy] /' >&2) 2>&1 &
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

# Give git a committer identity up front so the agent never has to invent one.
# Nothing else in the image or the injected env sets user.name/user.email, so
# without this every session improvised its own address at commit time — which
# is how ~40 fabricated identities (agent@maskin.ai, dev@maskin.ai,
# developer@maskin.local, ...) ended up in the history. Anything at a domain we
# do not own is claimable: verifying such an address on a GitHub account
# retroactively credits its holder as a contributor here. maskin.ai in
# particular is registered to someone else. Pin it to a domain we control.
setup_git_identity() {
  git config --global user.name "$GIT_IDENTITY_NAME"
  git config --global user.email "$GIT_IDENTITY_EMAIL"

  echo "[system] git identity set to $GIT_IDENTITY_NAME <$GIT_IDENTITY_EMAIL>"
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
  # Straight to stderr rather than a write-only /tmp file that dies with the
  # VM - `msb exec` carries stderr back to agent-server's structured logs.
  # Process substitution (not a pipeline) so $! stays node's own pid.
  node /preview-port-watcher.js > >(sed -u 's/^/[preview-port-watcher] /' >&2) 2>&1 &
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
  # `|| true` because this is a log shipper, not the agent: its failure must
  # never become the session's status, and under `set -e` (line 2) an
  # unguarded non-zero exit here would abort run_agent before the agent's own
  # status was recorded. run_agent_logged below now reads that status from the
  # agent's PID rather than from a pipeline, so the shipper's exit is fully
  # decoupled from it — but this guard still matters, because log_tee runs as a
  # background job whose failure would otherwise surface at `wait`.
  log_tee() {
    node /output-stream.js || true
  }

  # Run the agent with its output shipped through log_tee, WITHOUT gating the
  # agent's exit status on the output channel closing.
  #
  # The previous form was `agent 2>&1 | log_tee; AGENT_EXIT_CODE=${PIPESTATUS[0]}`.
  # A shell pipeline only returns once EVERY member exits, and log_tee exits on
  # EOF — which arrives only when the LAST holder of the pipe's write end closes
  # it. Any background process the agent spawned (a dev server, a database, a
  # watcher) inherits that fd and keeps it open after the agent itself is gone.
  # log_tee then never EOFs, the pipeline never returns, `AGENT_EXIT_CODE=` never
  # runs, and the EXIT trap never fires — so the session sat "running" until
  # SESSION_MAX_DURATION (8h) even though the agent had finished its work.
  # Session 5bd428eb (2026-09-08) wedged exactly this way after the agent started
  # the local devstack; ports 3000/5173/5432/8181/8333 were still relayed from
  # the VM with the agent long done. The same shape swallows the status when the
  # agent is SIGKILLed mid-pipeline (an OOM kill, session f6022f55 the same day).
  #
  # Waiting on the agent's own PID decouples the two: its status is available the
  # moment it exits, whatever else is still holding the fd. Draining is then
  # bounded separately, so a lingering holder costs LOG_DRAIN_GRACE_SECS rather
  # than hours.
  run_agent_logged() {
    local fifo
    fifo="$(mktemp -u /tmp/agent-out.XXXXXX)"
    mkfifo "$fifo"

    log_tee < "$fifo" &
    local tee_pid=$!

    # Inherits this function's stdin, so callers can still redirect it
    # (the interactive path feeds claude from input-stream.js).
    "$@" > "$fifo" 2>&1 &
    local agent_pid=$!

    # `|| rc=$?` keeps `set -e` from aborting on a non-zero agent status; the
    # whole point here is to CAPTURE that status, not die on it.
    local rc=0
    wait "$agent_pid" || rc=$?
    AGENT_EXIT_CODE=$rc
    AGENT_EXIT_CODE_CAPTURED=1

    # Let the shipper flush what the agent already wrote. If nothing else holds
    # the write end this EOFs at once; if something does, reap it on a timer so
    # teardown proceeds regardless.
    ( sleep "$LOG_DRAIN_GRACE_SECS"; kill "$tee_pid" 2>/dev/null ) &
    local reaper_pid=$!
    wait "$tee_pid" 2>/dev/null || true
    kill "$reaper_pid" 2>/dev/null || true
    rm -f "$fifo"

    return 0
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
          run_agent_logged claude -p \
            --input-format stream-json \
            --output-format stream-json \
            --verbose \
            --dangerously-skip-permissions \
            "${mcp_args[@]}" \
            < <(node /input-stream.js)
        else
          # Local Docker path: stdin is attached by ContainerManager.attachStdin.
          run_agent_logged claude -p \
            --input-format stream-json \
            --output-format stream-json \
            --verbose \
            --dangerously-skip-permissions \
            "${mcp_args[@]}"
        fi
      else
        run_agent_logged claude -p "$ACTION_PROMPT" \
          --print \
          --verbose \
          --output-format stream-json \
          --max-turns "$max_turns" \
          --dangerously-skip-permissions \
          "${mcp_args[@]}"
      fi
      ;;
    codex)
      local approval_mode="${CODEX_APPROVAL_MODE:-full-auto}"
      run_agent_logged codex \
        --approval-mode "$approval_mode" \
        --prompt "$ACTION_PROMPT"
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
      run_agent_logged "${custom_argv[@]}"
      ;;
  esac
}

echo "[system] Starting agent session: ${SESSION_ID:-unknown}"
echo "[system] Runtime: $RUNTIME"

install_runtime
build_context
setup_mcps
setup_claude_credentials
setup_git_identity
setup_github_credential_helper
start_preview_port_watcher

run_agent
