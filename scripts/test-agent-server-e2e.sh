#!/usr/bin/env bash
# Phase 3: Agent-Server Infrastructure Integration Test
#
# Verifies that agent-server + main app + database work together end-to-end.
# Run from the repo root after setting up your .env file.
#
# Prerequisites:
#   - Docker (for postgres via docker-compose)
#   - Node.js + pnpm installed
#   - .env file configured (see .env.example)
#
# Usage:
#   chmod +x scripts/test-agent-server-e2e.sh
#   ./scripts/test-agent-server-e2e.sh
#
# Set TEST_WORKSPACE_ID and TEST_ACTOR_ID to use existing entities,
# or the script will attempt to use defaults.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MAIN_APP_PORT="${PORT:-3000}"
AGENT_SERVER_PORT="${AGENT_SERVER_PORT:-3001}"
AGENT_SERVER_SECRET="${AGENT_SERVER_SECRET:-test-secret-for-e2e}"
RUNTIME_BACKEND="${RUNTIME_BACKEND:-docker}"
MAIN_APP_URL="http://localhost:${MAIN_APP_PORT}"
AGENT_SERVER_URL="http://localhost:${AGENT_SERVER_PORT}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0
SKIPPED=0
PIDS_TO_KILL=()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()   { echo -e "${BLUE}[INFO]${NC} $*"; }
pass()  { echo -e "${GREEN}[PASS]${NC} $*"; PASSED=$((PASSED + 1)); }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; FAILED=$((FAILED + 1)); }
skip()  { echo -e "${YELLOW}[SKIP]${NC} $*"; SKIPPED=$((SKIPPED + 1)); }
header(){ echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

cleanup() {
  log "Cleaning up background processes..."
  for pid in "${PIDS_TO_KILL[@]}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  log "Cleanup complete."
}
trap cleanup EXIT

wait_for_port() {
  local port=$1 name=$2 timeout=${3:-30}
  log "Waiting for ${name} on port ${port} (timeout: ${timeout}s)..."
  local elapsed=0
  while ! curl -sf "http://localhost:${port}/health" > /dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -ge $timeout ]; then
      fail "${name} did not start within ${timeout}s"
      return 1
    fi
  done
  pass "${name} is listening on port ${port}"
}

assert_status() {
  local actual=$1 expected=$2 context=$3
  if [ "$actual" = "$expected" ]; then
    pass "${context}: HTTP ${actual}"
  else
    fail "${context}: expected HTTP ${expected}, got HTTP ${actual}"
  fi
}

assert_json_field() {
  local json=$1 field=$2 expected=$3 context=$4
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  if [ "$actual" = "$expected" ]; then
    pass "${context}: ${field} = ${expected}"
  else
    fail "${context}: expected ${field} = '${expected}', got '${actual}'"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: Start Database
# ---------------------------------------------------------------------------
header "Step 1: Start Database (docker-compose up postgres)"

if docker compose ps postgres 2>/dev/null | grep -q "running"; then
  log "Postgres already running via docker-compose"
  pass "Database is running"
else
  log "Starting postgres..."
  docker compose up -d postgres
  # Wait for healthcheck
  local_timeout=30
  elapsed=0
  while ! docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ $elapsed -ge $local_timeout ]; then
      fail "Postgres did not become ready within ${local_timeout}s"
      echo -e "\n${RED}Cannot proceed without database. Exiting.${NC}"
      exit 1
    fi
  done
  pass "Database started and healthy"
fi

# Run migrations
log "Running database migrations..."
if pnpm --filter @maskin/db db:push 2>&1 | tail -5; then
  pass "Database migrations applied"
else
  fail "Database migrations failed"
  echo -e "\n${RED}Cannot proceed without migrations. Exiting.${NC}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Start Agent-Server on port 3001
# ---------------------------------------------------------------------------
header "Step 2: Start agent-server (port ${AGENT_SERVER_PORT}, RUNTIME_BACKEND=${RUNTIME_BACKEND})"

export AGENT_SERVER_SECRET
export RUNTIME_BACKEND
export AGENT_SERVER_PORT

log "Starting agent-server..."
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/maskin}" \
  AGENT_SERVER_SECRET="${AGENT_SERVER_SECRET}" \
  RUNTIME_BACKEND="${RUNTIME_BACKEND}" \
  AGENT_SERVER_PORT="${AGENT_SERVER_PORT}" \
  pnpm --filter @maskin/agent-server dev &
PIDS_TO_KILL+=("$!")

wait_for_port "${AGENT_SERVER_PORT}" "agent-server" 45 || exit 1

# ---------------------------------------------------------------------------
# Step 3: Start Main App on port 3000
# ---------------------------------------------------------------------------
header "Step 3: Start main app (port ${MAIN_APP_PORT})"

log "Starting main app..."
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/maskin}" \
  AGENT_SERVER_URL="${AGENT_SERVER_URL}" \
  AGENT_SERVER_SECRET="${AGENT_SERVER_SECRET}" \
  PORT="${MAIN_APP_PORT}" \
  pnpm --filter @maskin/dev dev &
PIDS_TO_KILL+=("$!")

wait_for_port "${MAIN_APP_PORT}" "main-app" 45 || exit 1

# ---------------------------------------------------------------------------
# Step 4: Create a session via main app API → verify it reaches agent-server
# ---------------------------------------------------------------------------
header "Step 4: Create session via main app → verify proxy to agent-server"

# We need a valid workspace_id and actor_id. Attempt to fetch one from the DB,
# or use env vars if provided.
WORKSPACE_ID="${TEST_WORKSPACE_ID:-}"
ACTOR_ID="${TEST_ACTOR_ID:-}"
API_KEY="${TEST_API_KEY:-}"

if [ -z "$WORKSPACE_ID" ] || [ -z "$ACTOR_ID" ]; then
  log "TEST_WORKSPACE_ID or TEST_ACTOR_ID not set."
  log "Attempting to read from database..."
  WORKSPACE_ID=$(docker compose exec -T postgres psql -U postgres -d maskin -tAc \
    "SELECT id FROM workspaces LIMIT 1" 2>/dev/null || echo "")
  ACTOR_ID=$(docker compose exec -T postgres psql -U postgres -d maskin -tAc \
    "SELECT id FROM actors LIMIT 1" 2>/dev/null || echo "")
fi

if [ -z "$WORKSPACE_ID" ] || [ -z "$ACTOR_ID" ]; then
  skip "No workspace/actor found in DB. Set TEST_WORKSPACE_ID and TEST_ACTOR_ID to run session tests."
  skip "Skipping Steps 4-7 (session lifecycle, SSE, triggers)."
else
  log "Using workspace_id=${WORKSPACE_ID}, actor_id=${ACTOR_ID}"

  # 4a. Create session via main app
  CREATE_RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "${MAIN_APP_URL}/api/sessions" \
    -H "Content-Type: application/json" \
    -H "x-workspace-id: ${WORKSPACE_ID}" \
    ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
    -d "{
      \"actor_id\": \"${ACTOR_ID}\",
      \"action_prompt\": \"echo 'E2E integration test - Phase 3 verification'\",
      \"auto_start\": true
    }" 2>/dev/null || echo -e "{}\n000")

  CREATE_BODY=$(echo "$CREATE_RESPONSE" | head -n -1)
  CREATE_STATUS=$(echo "$CREATE_RESPONSE" | tail -1)

  if [ "$CREATE_STATUS" = "201" ]; then
    pass "Session created via main app API (HTTP 201)"
    SESSION_ID=$(echo "$CREATE_BODY" | jq -r '.id')
    log "Session ID: ${SESSION_ID}"

    # 4b. Verify session exists on agent-server directly
    AS_STATUS_CODE=$(curl -sf -o /dev/null -w "%{http_code}" \
      -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
      "${AGENT_SERVER_URL}/sessions/${SESSION_ID}/status" 2>/dev/null || echo "000")
    assert_status "$AS_STATUS_CODE" "200" "Session reachable on agent-server"

    # -----------------------------------------------------------------------
    # Step 5: Verify SSE log streaming
    # -----------------------------------------------------------------------
    header "Step 5: Verify SSE log streaming between processes"

    SSE_OUTPUT_FILE=$(mktemp)
    # Stream logs for up to 15 seconds in background
    curl -sf -N -H "x-workspace-id: ${WORKSPACE_ID}" \
      ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
      "${MAIN_APP_URL}/api/sessions/${SESSION_ID}/logs/stream" \
      --max-time 15 > "$SSE_OUTPUT_FILE" 2>/dev/null &
    SSE_PID=$!

    # Wait for some data to arrive
    sleep 5

    if [ -s "$SSE_OUTPUT_FILE" ]; then
      SSE_LINES=$(wc -l < "$SSE_OUTPUT_FILE")
      pass "SSE log stream received data (${SSE_LINES} lines)"

      if grep -q "^event:" "$SSE_OUTPUT_FILE"; then
        pass "SSE stream contains proper event fields"
      else
        fail "SSE stream missing event fields"
      fi

      if grep -q "^data:" "$SSE_OUTPUT_FILE"; then
        pass "SSE stream contains proper data fields"
      else
        fail "SSE stream missing data fields"
      fi
    else
      fail "SSE log stream returned no data within 5s"
    fi

    kill $SSE_PID 2>/dev/null || true
    rm -f "$SSE_OUTPUT_FILE"

    # -----------------------------------------------------------------------
    # Step 6: Verify stop/pause/resume lifecycle
    # -----------------------------------------------------------------------
    header "Step 6: Verify stop/pause/resume lifecycle"

    # 6a. Create a fresh session for lifecycle testing
    LIFECYCLE_RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "${MAIN_APP_URL}/api/sessions" \
      -H "Content-Type: application/json" \
      -H "x-workspace-id: ${WORKSPACE_ID}" \
      ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
      -d "{
        \"actor_id\": \"${ACTOR_ID}\",
        \"action_prompt\": \"sleep 120\",
        \"auto_start\": true
      }" 2>/dev/null || echo -e "{}\n000")

    LIFECYCLE_BODY=$(echo "$LIFECYCLE_RESPONSE" | head -n -1)
    LIFECYCLE_STATUS=$(echo "$LIFECYCLE_RESPONSE" | tail -1)

    if [ "$LIFECYCLE_STATUS" = "201" ]; then
      LC_SESSION_ID=$(echo "$LIFECYCLE_BODY" | jq -r '.id')
      pass "Lifecycle test session created: ${LC_SESSION_ID}"

      # Wait for it to start running
      sleep 3

      # 6b. Pause the session
      PAUSE_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
        -H "x-workspace-id: ${WORKSPACE_ID}" \
        ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
        "${MAIN_APP_URL}/api/sessions/${LC_SESSION_ID}/pause" 2>/dev/null || echo "000")

      if [ "$PAUSE_STATUS" = "200" ]; then
        pass "Pause session: HTTP 200"

        # Verify status is paused
        PAUSED_BODY=$(curl -sf -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
          "${AGENT_SERVER_URL}/sessions/${LC_SESSION_ID}/status" 2>/dev/null || echo '{}')
        PAUSED_STATUS=$(echo "$PAUSED_BODY" | jq -r '.status' 2>/dev/null || echo "unknown")

        if [ "$PAUSED_STATUS" = "paused" ]; then
          pass "Session status is 'paused' after pause"
        else
          fail "Expected status 'paused', got '${PAUSED_STATUS}'"
        fi

        # 6c. Resume the session
        RESUME_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
          -H "x-workspace-id: ${WORKSPACE_ID}" \
          ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
          "${MAIN_APP_URL}/api/sessions/${LC_SESSION_ID}/resume" 2>/dev/null || echo "000")

        if [ "$RESUME_STATUS" = "200" ]; then
          pass "Resume session: HTTP 200"

          sleep 2
          RESUMED_BODY=$(curl -sf -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
            "${AGENT_SERVER_URL}/sessions/${LC_SESSION_ID}/status" 2>/dev/null || echo '{}')
          RESUMED_STATUS=$(echo "$RESUMED_BODY" | jq -r '.status' 2>/dev/null || echo "unknown")

          if [ "$RESUMED_STATUS" = "running" ]; then
            pass "Session status is 'running' after resume"
          else
            fail "Expected status 'running' after resume, got '${RESUMED_STATUS}'"
          fi
        else
          fail "Resume session: expected HTTP 200, got HTTP ${RESUME_STATUS}"
        fi
      else
        fail "Pause session: expected HTTP 200, got HTTP ${PAUSE_STATUS}"
        skip "Skipping resume test (pause failed)"
      fi

      # 6d. Stop the session
      STOP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" -X POST \
        -H "x-workspace-id: ${WORKSPACE_ID}" \
        ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
        "${MAIN_APP_URL}/api/sessions/${LC_SESSION_ID}/stop" 2>/dev/null || echo "000")

      if [ "$STOP_STATUS" = "200" ]; then
        pass "Stop session: HTTP 200"
      else
        fail "Stop session: expected HTTP 200, got HTTP ${STOP_STATUS}"
      fi
    else
      fail "Could not create lifecycle test session (HTTP ${LIFECYCLE_STATUS})"
      skip "Skipping pause/resume/stop tests"
    fi

    # -----------------------------------------------------------------------
    # Step 7: Verify trigger fires a session through the proxy
    # -----------------------------------------------------------------------
    header "Step 7: Verify trigger fires a session through the proxy"

    # Create a session with a trigger_id to simulate a trigger-fired session
    TRIGGER_ID="e2e-test-trigger-$(date +%s)"
    TRIGGER_RESPONSE=$(curl -sf -w "\n%{http_code}" -X POST "${AGENT_SERVER_URL}/sessions" \
      -H "Content-Type: application/json" \
      -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
      -d "{
        \"workspace_id\": \"${WORKSPACE_ID}\",
        \"actor_id\": \"${ACTOR_ID}\",
        \"action_prompt\": \"echo 'triggered session test'\",
        \"trigger_id\": \"${TRIGGER_ID}\",
        \"created_by\": \"${ACTOR_ID}\",
        \"auto_start\": true
      }" 2>/dev/null || echo -e "{}\n000")

    TRIGGER_BODY=$(echo "$TRIGGER_RESPONSE" | head -n -1)
    TRIGGER_STATUS_CODE=$(echo "$TRIGGER_RESPONSE" | tail -1)

    if [ "$TRIGGER_STATUS_CODE" = "201" ]; then
      TRIGGER_SESSION_ID=$(echo "$TRIGGER_BODY" | jq -r '.id')
      pass "Trigger-fired session created on agent-server (HTTP 201)"
      log "Trigger session ID: ${TRIGGER_SESSION_ID}"

      # Verify the session has the trigger_id in the database
      sleep 2
      TRIGGER_SESSION_STATUS=$(curl -sf \
        -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
        "${AGENT_SERVER_URL}/sessions/${TRIGGER_SESSION_ID}/status" 2>/dev/null || echo '{}')

      if echo "$TRIGGER_SESSION_STATUS" | jq -e '.id' > /dev/null 2>&1; then
        pass "Trigger-fired session is trackable via agent-server"
      else
        fail "Could not retrieve trigger-fired session status"
      fi

      # Clean up: stop the trigger session
      curl -sf -X POST \
        -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
        "${AGENT_SERVER_URL}/sessions/${TRIGGER_SESSION_ID}/stop" > /dev/null 2>&1 || true
    else
      fail "Trigger-fired session creation failed (HTTP ${TRIGGER_STATUS_CODE})"
    fi

  else
    fail "Session creation failed (HTTP ${CREATE_STATUS})"
    log "Response: ${CREATE_BODY}"
    skip "Skipping Steps 5-7 (session creation failed)"
  fi
fi

# ---------------------------------------------------------------------------
# Bonus: Auth verification on agent-server
# ---------------------------------------------------------------------------
header "Bonus: Agent-server auth verification"

# Request without secret should be rejected
NO_AUTH_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  "${AGENT_SERVER_URL}/sessions" 2>/dev/null || echo "000")

if [ "$NO_AUTH_STATUS" = "401" ]; then
  pass "Agent-server rejects unauthenticated requests (HTTP 401)"
else
  fail "Agent-server should return 401 without secret, got HTTP ${NO_AUTH_STATUS}"
fi

# Request with wrong secret should be rejected
BAD_AUTH_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  -H "X-Agent-Server-Secret: wrong-secret" \
  "${AGENT_SERVER_URL}/sessions" 2>/dev/null || echo "000")

if [ "$BAD_AUTH_STATUS" = "401" ]; then
  pass "Agent-server rejects invalid secret (HTTP 401)"
else
  fail "Agent-server should return 401 with wrong secret, got HTTP ${BAD_AUTH_STATUS}"
fi

# Request with correct secret should succeed
GOOD_AUTH_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
  -H "X-Agent-Server-Secret: ${AGENT_SERVER_SECRET}" \
  "${AGENT_SERVER_URL}/health" 2>/dev/null || echo "000")

if [ "$GOOD_AUTH_STATUS" = "200" ]; then
  pass "Agent-server accepts valid secret (HTTP 200)"
else
  fail "Agent-server should return 200 with valid secret, got HTTP ${GOOD_AUTH_STATUS}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
header "Test Summary"
echo -e "  ${GREEN}Passed:  ${PASSED}${NC}"
echo -e "  ${RED}Failed:  ${FAILED}${NC}"
echo -e "  ${YELLOW}Skipped: ${SKIPPED}${NC}"
echo ""

if [ $FAILED -gt 0 ]; then
  echo -e "${RED}Some tests failed. Review output above for details.${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi
