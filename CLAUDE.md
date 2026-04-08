# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Sub-project CLAUDE.md
- `apps/web/CLAUDE.md` — detailed frontend guidance: product philosophy, design system, component conventions, routing, state management, SSE patterns, and styling rules

## Project Rules
- `.claude/rules/frontend.md` — frontend component reuse, DRY, and consistency rules (shadcn/ui, Radix UI)
- `.claude/rules/testing.md` — testing conventions for all test types (unit, integration, E2E, frontend)
- `.claude/rules/pre-commit.md` — pre-commit checklist (lint, type-check, tests)

## Architecture
- Modular monorepo managed by Turborepo + pnpm workspaces: `apps/` (deployable services) + `packages/` (shared libs)
- Backend (`apps/dev`): Hono.js + OpenAPIHono + Drizzle ORM + PostgreSQL, runs on port 3000
- Frontend (`apps/web`): Vite + React 19 + TanStack Router + TanStack Query + Tailwind CSS 4, runs on port 5173, proxies `/api` to backend
- Auth: API keys (plain text, `ank_` prefix). Bearer token in Authorization header
- Real-time: PG NOTIFY → SSE bridge (packages/realtime) — events table has a DB trigger that fires NOTIFY on insert
- Agent execution: Docker-based container sessions in `apps/dev/src/services/session-manager.ts` — spins up ephemeral containers running Claude Code, Codex, or custom CLIs. Persistent agent files (skills, learnings, memory) stored in S3-compatible storage (SeaweedFS for dev). Sessions are trackable, streamable via SSE, pausable/resumable via snapshots.
- Container management: `apps/dev/src/services/container-manager.ts` wraps dockerode
- Agent file storage: `packages/storage` provides abstract `StorageProvider` interface with S3 implementation (`@aws-sdk/client-s3`). `apps/dev/src/services/agent-storage.ts` manages pull/push of agent files.
- MCP server: `packages/mcp` wraps the API as 38 tools for external agents (stdio + HTTP transport)
- Workspace context passed via `X-Workspace-Id` header on all workspace-scoped routes

## Prerequisites
- Node.js ≥ 20
- pnpm 9.15.0

## Commands
- `pnpm install` — install all dependencies
- `pnpm dev` — start Docker (postgres + seaweedfs), run migrations, then start all services via Turborepo
- `pnpm dev:win` — same as above but for cmd/PowerShell on Windows (uses Node script instead of bash)
- `pnpm build` — build all packages
- `pnpm --filter=@maskin/mcp build` — build a specific package (filter goes BEFORE `build`)
- `pnpm --filter=@maskin/web build` — build web app only
- `pnpm test` — run all tests (Vitest)
- `pnpm test -- --filter=@maskin/dev` — run tests for a specific package
- `cd apps/dev && pnpm vitest run src/__tests__/auth.test.ts` — run a single test file
- `pnpm test:integration` — run integration tests (requires real database)
- `pnpm type-check` — TypeScript type checking across all packages
- `pnpm lint` — lint with Biome (`biome check .`)
- `pnpm lint:fix` — auto-fix lint issues
- `pnpm format` — format with Biome
- `docker-compose up postgres -d` — start PostgreSQL only (not needed if using `pnpm dev`)
- `docker-compose up` — start PostgreSQL + all services
- `pnpm db:generate` — generate Drizzle migration from schema changes
- `pnpm db:migrate` — run Drizzle migrations (automatically run by `pnpm dev`)
- `pnpm db:seed` — seed demo data

## Code Conventions
- Biome for linting + formatting (not ESLint/Prettier) — ignores `node_modules`, `dist`, `drizzle`, `.turbo`
- Tab indentation, single quotes, semicolons as-needed, 100 char line width
- All validation via Zod schemas in `packages/shared/src/schemas/`
- Drizzle for all DB access — SQL-like API, no magic
- Route files export a Hono app, mounted in `apps/dev/src/index.ts`
- Events logged on every mutation (create/update/delete) for audit + real-time
- All write endpoints accept `Idempotency-Key` header
- Frontend uses `@` path alias mapped to `/src` in `apps/web`
- Frontend routing: file-based with TanStack Router (`apps/web/src/routes/`), `routeTree.gen.ts` is auto-generated
- Frontend data fetching: TanStack Query hooks in `apps/web/src/hooks/`, API client in `apps/web/src/lib/api.ts`
- Frontend SSE: real-time cache invalidation via `apps/web/src/lib/sse-invalidation.ts`
- UI components: Radix UI primitives + custom components in `apps/web/src/components/ui/`

## Data Model
- Unified `objects` table with `type` field: 'insight' | 'bet' | 'task'
- `actors` table: humans and agents share the same identity model
- `workspaces` with configurable settings (statuses, field definitions, display names)
- `workspace_members` — joins actors to workspaces with roles
- `events` table = audit log + real-time feed (PG NOTIFY trigger)
- `relationships` = universal edge table between objects (unique on source_id + target_id + type)
- `triggers` = cron or event-based automation, fires agents via container sessions
- `sessions` = container execution sessions, tracks lifecycle (pending → running → completed/paused/failed/timeout)
- `session_logs` = append-only log output from container sessions (stdout/stderr/system), used for SSE streaming
- `agent_files` = metadata index for agent files stored in S3 (skills, learnings, memory)

## API Routes

### Public (no auth)
- `GET /api/health` — health check
- `GET /api/openapi.json` — OpenAPI spec
- `POST /api/actors` — signup, returns API key

### Actors (`/api/actors`)
- `GET /api/actors` — list actors
- `GET /api/actors/:id` — get actor by ID
- `PATCH /api/actors/:id` — update actor
- `POST /api/actors/:id/api-keys` — regenerate API key

### Objects (`/api/objects`) — unified CRUD for insight/bet/task
- `POST /api/objects` — create object
- `GET /api/objects` — list objects (filter by type, status, owner)
- `GET /api/objects/search` — search objects by text in title/content
- `GET /api/objects/:id` — get object by ID
- `GET /api/objects/:id/graph` — get object with all relationships and connected objects
- `PATCH /api/objects/:id` — update object
- `DELETE /api/objects/:id` — delete object

### Workspaces (`/api/workspaces`)
- `POST /api/workspaces` — create workspace
- `GET /api/workspaces` — list workspaces for current actor
- `PATCH /api/workspaces/:id` — update workspace
- `POST /api/workspaces/:id/members` — add member
- `GET /api/workspaces/:id/members` — list members

### Relationships (`/api/relationships`)
- `POST /api/relationships` — create relationship
- `GET /api/relationships` — list relationships (filter by source_id, target_id, type)
- `DELETE /api/relationships/:id` — delete relationship

### Triggers (`/api/triggers`)
- `POST /api/triggers` — create trigger
- `GET /api/triggers` — list triggers
- `PATCH /api/triggers/:id` — update trigger
- `DELETE /api/triggers/:id` — delete trigger

### Events (`/api/events`)
- `GET /api/events` — SSE stream (supports Last-Event-ID)
- `GET /api/events/history` — paginated event history

### Sessions (`/api/sessions`) — container-based agent execution
- `POST /api/sessions` — create session
- `GET /api/sessions` — list sessions
- `GET /api/sessions/:id` — get session details
- `POST /api/sessions/:id/stop` — stop session
- `POST /api/sessions/:id/pause` — pause & snapshot session
- `POST /api/sessions/:id/resume` — resume paused session
- `GET /api/sessions/:id/logs` — paginated log history
- `GET /api/sessions/:id/logs/stream` — SSE stream of live logs

### Graph (`/api/graph`) — batch operations
- `POST /api/graph` — atomic batch create (objects + relationships in one transaction)

### Integrations (`/api/integrations`)
- `GET /api/integrations` — list integrations for workspace
- `GET /api/integrations/providers` — list available providers
- `POST /api/integrations/:provider/connect` — start OAuth/connection flow
- `GET /api/integrations/:provider/callback` — OAuth callback (no auth)
- `DELETE /api/integrations/:id` — disconnect integration

### Webhooks (`/api/webhooks`) — no auth
- `POST /api/webhooks/:provider` — incoming webhook handler

### MCP HTTP Transport
- `POST /mcp` — Streamable HTTP transport for MCP Apps

## Testing
- **Full conventions**: see `.claude/rules/testing.md` for patterns, file locations, and examples
- **Pre-commit**: see `.claude/rules/pre-commit.md` — always run lint, type-check, and tests before committing
- Backend unit tests: Vitest with mock DB context (`apps/dev/src/__tests__/setup.ts`)
- Backend integration tests: Vitest with real PostgreSQL (`apps/dev/src/__tests__/integration/`)
- Frontend tests: Vitest + React Testing Library + jsdom (`apps/web/src/__tests__/`)
- E2E tests: Playwright (`apps/e2e/src/tests/`)
- Test pyramid for frontend: lib utilities → hooks → components
- `pnpm test -- --run` — run all unit tests
- `pnpm test:integration -- --run` — run integration tests (requires DATABASE_URL)
- `pnpm test:e2e` — run E2E tests (requires running dev server)

## Environment Variables
- `DATABASE_URL` — PostgreSQL connection string (required)
- `PORT` — server port (default 3000)
- `S3_ENDPOINT` — S3-compatible storage endpoint (default: `http://localhost:8333` for SeaweedFS)
- `S3_BUCKET` — storage bucket name (default: `agent-files`)
- `S3_ACCESS_KEY`, `S3_SECRET_KEY` — S3 credentials (default: `admin`/`admin` for dev)
- `S3_REGION` — S3 region (default: `us-east-1`)
- `CORS_ORIGIN` — comma-separated allowed origins for CORS (default: `http://localhost:5173`)

**Important**: All env vars used at runtime must be listed in `turbo.json` `globalPassThroughEnv`. Turbo filters env vars — unlisted ones are silently unavailable to dev/build tasks. When adding new env vars (e.g., for integrations), always add them there too.

## Principles
1. Simple & intuitive
2. Speed — blazingly fast
3. Everything's an API
4. Transparent — live feedback on everything
5. Agents-first — agents run autonomously
6. Idempotency — all write endpoints accept Idempotency-Key
7. Observability — structured logging from day one
