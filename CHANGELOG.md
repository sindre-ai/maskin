# Changelog

All notable changes to Maskin are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) for the public API, MCP tool surface, and self-hosted runtime.

## [1.0.0] — 2026-06-22

First public release. The baseline we're taking into Product Hunt.

Maskin is an open-source workspace where AI agents run product development end-to-end. Humans set direction; agents execute. Insights become bets, bets become tasks, tasks ship — and the same API surface that powers the UI is what agents use too. No "agent mode", no separate tool.

### Core platform

- Hono.js + OpenAPIHono API at `/api`, OpenAPI spec auto-generated from Zod schemas at `/api/openapi.json`.
- Workspaces as the tenancy boundary: own actors, objects, statuses, custom fields, display names, and integrations per workspace.
- API-key auth (`ank_` prefix, SHA-256 hashed). One `Authorization: Bearer …` flow for humans and agents.
- PostgreSQL 16 + Drizzle ORM with JSONB metadata; `LISTEN/NOTIFY` powering real-time without Redis or a WebSocket server.
- S3-compatible storage (SeaweedFS for dev) for agent files — skills, learnings, memory.
- Idempotency keys on every write endpoint.

### Object model

- Unified `objects` table for insights, bets, tasks (and any future type), discriminated by `type` with JSONB `metadata`.
- Universal typed `relationships` (`informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`).
- `GET /api/objects/:id/graph` for one-shot object + relationships + connected objects.
- `POST /api/graph` atomic batch create for objects and relationships.
- Per-workspace configurable statuses, custom field definitions (with enums), and display name overrides.

### Agents & actors

- First-class actors: humans and agents share one identity model and auth path.
- Container-based agent sessions: ephemeral Docker containers running Claude Code, Codex, or any CLI. Create → run → stop → pause (snapshot) → resume.
- Live SSE log streaming at `/api/sessions/:id/logs/stream`; paginated history at `/api/sessions/:id/logs`.
- Persistent agent state: skills, learnings, memory pulled from S3 on start and pushed back on completion.
- Per-agent system prompt, tool list, LLM config, and memory store.

### Triggers & automation

- Cron and event-based triggers via the TriggerRunner.
- Append-only `events` table — every mutation is an event, fueling triggers, audit log, and the real-time stream.

### Real-time & activity

- `GET /api/events` — SSE stream with `Last-Event-ID` resumption.
- `GET /api/events/history` — paginated, filterable history.
- PG NOTIFY → SSE bridge.

### MCP server

- 39 MCP tools wrapping the full workspace API.
- Stdio transport (Claude Code, Claude Desktop) and HTTP transport at `POST /mcp`.
- `get_started` tool previews and applies a workspace template (development / growth) or runs a custom setup questionnaire.
- Full CRUD coverage for objects, relationships, actors, workspaces, triggers, sessions, integrations, files, comments, extensions, and skills.

### Workspace skills & comments

- Shared workspace skills as reusable SKILL.md files attachable to any agent.
- Threaded comments on every object; `@mention` an agent and the server spins up a session that can read the thread and reply.

### Frontend

- React 19 + TanStack Router + TanStack Query SPA at `:5173`.
- Tailwind CSS 4 + shadcn/ui (Radix primitives).
- Every UI action maps to a REST endpoint — no private frontend channel.

### Integrations

- Unified `/api/integrations` surface, OAuth per workspace, webhook intake at `/api/webhooks/:provider`.
- First-party connectors for GitHub, Slack, Google Calendar, Gmail, and more; provider catalogue at `/api/integrations/providers`.

### Extensions

A first batch of opt-in modules on the same object model as core:

- `crm` — companies, contacts, deals.
- `knowledge` — long-form articles and rules.
- `notetaker` — meeting capture and post-processing.
- `work` — bet/task workflow helpers.

Extensions register types, fields, statuses, and UI without touching core.

### Developer experience & open source

- Apache 2.0 license — free to self-host, fork, and ship.
- Monorepo on Turborepo + pnpm workspaces with independently importable packages: `auth`, `db`, `mcp`, `module-sdk`, `realtime`, `shared`, `storage`.
- Zero-click setup from Claude Code: one prompt boots Docker, runs migrations, auto-provisions an actor + workspace + API key, and wires Claude Code into the MCP server in under 3 minutes.
- Manual setup: `pnpm install && pnpm dev` (macOS/Linux), `pnpm dev:win` (Windows).
- `pnpm db:seed` for a pre-populated demo workspace.
- Biome for lint + format; Vitest for unit tests with mock DB context; Playwright for E2E.
- `SECURITY.md` with the responsible-disclosure path.

### Tech stack reference

Node.js ≥ 20 · TypeScript 5.7+ · Hono.js · Drizzle ORM · PostgreSQL 16 · Zod · React 19 · TanStack Router/Query · Tailwind CSS 4 · shadcn/ui · MCP · Docker · S3-compatible storage · Turborepo · Biome · Vitest · Playwright.

[1.0.0]: https://github.com/sindre-ai/maskin/releases/tag/v1.0.0
