# Phase 3: Agent-Server Integration Test Procedure

This document describes how to verify that the Phase 3 agent-server infrastructure works end-to-end with real services (database, agent-server, main app).

PR #231 delivered mock-based automated tests. This procedure complements those with real infrastructure verification.

## Quick Start

```bash
chmod +x scripts/test-agent-server-e2e.sh
./scripts/test-agent-server-e2e.sh
```

The script handles starting services, running tests, and cleanup automatically.

## Prerequisites

- Docker installed and running (for PostgreSQL via docker-compose)
- Node.js 20+ and pnpm installed
- `.env` file configured (copy from `.env.example`)
- `curl` and `jq` available on PATH

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/maskin` | PostgreSQL connection string |
| `AGENT_SERVER_SECRET` | `test-secret-for-e2e` | Shared secret between main app and agent-server |
| `AGENT_SERVER_PORT` | `3001` | Port for agent-server |
| `PORT` | `3000` | Port for main app |
| `RUNTIME_BACKEND` | `docker` | Runtime backend (`docker` or `microsandbox`) |
| `TEST_WORKSPACE_ID` | *(auto-detected from DB)* | Workspace ID for session tests |
| `TEST_ACTOR_ID` | *(auto-detected from DB)* | Actor ID for session tests |
| `TEST_API_KEY` | *(optional)* | API key for main app auth |

## What the Script Tests

### Step 1: Database
- Starts PostgreSQL via `docker compose up postgres`
- Waits for healthcheck to pass
- Runs database migrations via `pnpm --filter @maskin/db db:push`

### Step 2: Agent-Server
- Starts `apps/agent-server` on port 3001 with `RUNTIME_BACKEND=docker`
- Verifies `/health` endpoint responds

### Step 3: Main App
- Starts `apps/dev` on port 3000 with `AGENT_SERVER_URL` pointing to agent-server
- Verifies `/health` endpoint responds

### Step 4: Session Creation via Proxy
- Creates a session via `POST /api/sessions` on the main app
- Verifies the session is accessible on agent-server directly
- Confirms the main app's thin-client SessionManager proxies correctly

### Step 5: SSE Log Streaming
- Opens an SSE connection to `GET /api/sessions/:id/logs/stream` on the main app
- Verifies that event and data fields are present in the stream
- Confirms log data flows from agent-server → database → main app SSE

### Step 6: Stop/Pause/Resume Lifecycle
- Creates a long-running session (`sleep 120`)
- **Pause**: `POST /api/sessions/:id/pause` → verifies status becomes `paused`
- **Resume**: `POST /api/sessions/:id/resume` → verifies status becomes `running`
- **Stop**: `POST /api/sessions/:id/stop` → verifies the session stops

### Step 7: Trigger-Fired Session
- Creates a session directly on agent-server with a `trigger_id` field
- Verifies the trigger-fired session is trackable and runs correctly
- Simulates what happens when the trigger scheduler fires a session

### Bonus: Auth Verification
- Verifies agent-server rejects requests without `X-Agent-Server-Secret`
- Verifies agent-server rejects requests with an incorrect secret
- Verifies agent-server accepts requests with the correct secret

## Manual Checklist

If you prefer to run steps manually instead of using the script:

- [ ] `docker compose up -d postgres` — database is running and healthy
- [ ] `pnpm --filter @maskin/db db:push` — migrations applied
- [ ] Start agent-server: `RUNTIME_BACKEND=docker AGENT_SERVER_SECRET=test-secret pnpm --filter @maskin/agent-server dev`
- [ ] Verify: `curl http://localhost:3001/health` returns `{"status":"ok"}`
- [ ] Start main app: `AGENT_SERVER_URL=http://localhost:3001 AGENT_SERVER_SECRET=test-secret pnpm --filter @maskin/dev dev`
- [ ] Verify: `curl http://localhost:3000/health` returns OK
- [ ] Create session via main app and verify it appears in agent-server
- [ ] Open SSE log stream and verify events flow
- [ ] Pause a running session → check status is `paused`
- [ ] Resume the paused session → check status is `running`
- [ ] Stop the session → check it terminates
- [ ] Create a session with `trigger_id` on agent-server → verify it runs
- [ ] Verify `curl http://localhost:3001/sessions` without auth header returns 401

## Troubleshooting

**Agent-server won't start**: Check that `DATABASE_URL` is correct and postgres is running. Check that `AGENT_SERVER_SECRET` is set.

**Session creation fails with 500**: Check agent-server logs for runtime backend errors. If using `RUNTIME_BACKEND=docker`, ensure Docker daemon is running and the agent-base image is built.

**SSE stream returns no data**: The session may have completed too quickly. Try with a longer-running action prompt like `sleep 30`.

**Auth tests fail**: Ensure `AGENT_SERVER_SECRET` matches between the agent-server process and your test requests.

**No workspace/actor found**: The script needs at least one workspace and actor in the database. Either seed the database first or set `TEST_WORKSPACE_ID` and `TEST_ACTOR_ID` manually.
