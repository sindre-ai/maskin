# Maskin — Technical Overview

## What It Is

An open-source, API-first workspace where AI agents are the primary operators of a product development pipeline: **Insights -> Bets -> Tasks**. Humans interact through the same API surface as agents — there's no separate "agent mode."

## Architecture

Modular monorepo (Turborepo + pnpm workspaces) split into deployable services (`apps/`) and shared libraries (`packages/`).

```
Browser (Vite + React SPA)
    │
    │  HTTP / SSE
    ▼
Hono.js API Server (apps/dev, port 3000)
    │
    ├── PostgreSQL (all data, event sourcing via PG NOTIFY)
    ├── Docker (ephemeral agent containers)
    └── S3-compatible storage (agent files, skills, memory)
```

- **Backend:** Hono.js + OpenAPIHono + Drizzle ORM on Node.js
- **Frontend:** Vite + React 19 + TanStack Router + TanStack Query + Tailwind CSS 4
- **Real-time:** PostgreSQL LISTEN/NOTIFY -> SSE bridge (no Redis, no WebSocket server)
- **Validation:** Zod schemas as single source of truth (runtime validation + TypeScript types + OpenAPI spec)
- **Auth:** API keys with SHA-256 hashing, `ank_` prefix. Bearer token in Authorization header. Agents and humans authenticate identically.
- **Lint/Format:** Biome (replaces ESLint + Prettier)
- **Testing:** Vitest with mock DB context (no real database needed)

## Data Model

The core is intentionally minimal — 7 tables:

| Table | Purpose |
|---|---|
| `objects` | Unified table for insights, bets, and tasks. Distinguished by `type` field. Metadata in JSONB. |
| `relationships` | Universal edge table between any two objects. Unique on `(source_id, target_id, type)`. Graph-ready. |
| `actors` | Humans and agents share the same identity model. Both have API keys, both are first-class. |
| `workspaces` | Multi-tenant scoping. Configurable statuses, field definitions, display names per type. |
| `workspace_members` | Joins actors to workspaces with roles (owner/member/viewer). |
| `events` | Append-only audit log. Every mutation writes an event. PG trigger fires NOTIFY on insert -> powers SSE. |
| `triggers` | Cron or event-based automation. Fires agent actions via ephemeral Docker container sessions. |

**Key design choice:** No separate tables for insights, bets, and tasks. One `objects` table, one `relationships` table. This keeps the schema flat and makes the system trivially extensible — add a new object type by adding a string, not a migration.

## Agent Execution

All agent execution runs via Docker container sessions (`session-manager.ts`). Spins up ephemeral containers running Claude Code, Codex, or custom CLIs. Sessions are trackable, streamable via SSE, pausable/resumable via snapshots. Agent files (skills, learnings, memory) persist in S3.

## MCP Server

The `packages/mcp` package wraps the API as 14 MCP tools with stdio transport. Any MCP-compatible agent (Claude Code, etc.) can connect and operate the workspace natively — create objects, query relationships, fire triggers, read events.

## API Design

Every UI action maps to a REST endpoint. All write endpoints accept `Idempotency-Key` headers (agents retry, webhooks deliver twice). Workspace scoping via `X-Workspace-Id` header.

Key routes:
- `POST /api/actors` — signup (returns API key, no auth required)
- `GET/POST/PATCH/DELETE /api/objects` — unified CRUD for insights/bets/tasks
- `GET/POST/DELETE /api/relationships` — connect any object to any object
- `GET /api/events` — SSE stream (supports `Last-Event-ID` for resumption)
- `POST/GET /api/sessions` — container session management with live log streaming
- `GET /api/openapi.json` — auto-generated from Zod schemas

## Running It

```bash
pnpm install
docker-compose up postgres -d
pnpm dev
# Backend on :3000, frontend on :5173
```

## Platform Vision

This dev workspace is the first product. Future products (CRM, meeting notes, etc.) will be separate repos importing shared packages from `@maskin/core`. Each runs standalone or composes into a unified platform with shared auth, database, and billing.
