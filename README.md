# AI-Native OSS Workspace

<!-- badges placeholder -->
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-green.svg)](https://nodejs.org/)

An open-source workspace where AI agents run product development autonomously. Humans set direction, agents execute.

## What is this?

- **Open-source workspace** where AI agents run product development end-to-end
- **Core pipeline:** Insights (signals from users, data, market) -> Bets (hypotheses to validate) -> Tasks (concrete work items) -> Feedback Loop
- **Agents are first-class citizens** -- they create insights, propose bets, break down tasks, and execute. Humans course-correct
- **Everything is an API** -- UI and agents use the same endpoints. No special agent interface, no separate human interface
- **Unified object model** -- insights, bets, and tasks are all "objects" with the same schema, connected by relationships

## Quick Start

```bash
# Clone and install
git clone https://github.com/your-org/ai-native-oss.git && cd ai-native-oss
pnpm install

# Start everything (Docker, migrations, backend + frontend)
pnpm dev

# On Windows (cmd/PowerShell), use:
pnpm dev:win

# Seed demo data (optional)
pnpm db:seed
```

`pnpm dev` automatically starts PostgreSQL + SeaweedFS via Docker, runs pending migrations, then launches all services.

Backend starts at `http://localhost:3000` (`/api/health` to verify). Frontend starts at `http://localhost:5173`.

## Architecture

```
ai-native-oss/
├── apps/
│   ├── dev/                    # Backend API server (Hono.js)
│   │   ├── src/
│   │   │   ├── index.ts        # App entry, middleware, route mounting
│   │   │   ├── routes/         # REST endpoints
│   │   │   │   ├── objects.ts
│   │   │   │   ├── actors.ts
│   │   │   │   ├── workspaces.ts
│   │   │   │   ├── relationships.ts
│   │   │   │   ├── triggers.ts
│   │   │   │   ├── events.ts
│   │   │   │   ├── sessions.ts
│   │   │   │   ├── integrations.ts
│   │   │   │   └── graph.ts
│   │   │   ├── services/
│   │   │   │   ├── trigger-runner.ts     # Cron + event-based automation
│   │   │   │   ├── session-manager.ts    # Container-based agent sessions
│   │   │   │   ├── container-manager.ts  # Docker container lifecycle
│   │   │   │   └── agent-storage.ts      # S3 agent file pull/push
│   │   │   └── lib/
│   │   │       └── llm/        # LLM provider adapters
│   │   │           ├── openai.ts
│   │   │           └── anthropic.ts
│   │   └── Dockerfile
│   ├── web/                    # Frontend (React + TanStack)
│   │   └── src/
│   │       ├── routes/         # File-based routing (TanStack Router)
│   │       ├── components/     # UI primitives, shared, and feature components
│   │       ├── hooks/          # TanStack Query hooks per resource
│   │       └── lib/            # API client, auth, SSE, utilities
│   └── e2e/                    # E2E tests (Playwright)
│       └── src/
│           ├── tests/          # Test specs (auth, CRUD, navigation)
│           ├── fixtures/       # Auth fixtures
│           └── helpers/        # API test helpers
├── scripts/
│   ├── dev.sh                  # Dev startup script (bash/macOS/Linux)
│   └── dev.mjs                 # Dev startup script (Windows cmd/PowerShell)
├── packages/
│   ├── db/                     # Drizzle ORM schema + migrations
│   ├── auth/                   # API key auth (SHA-256 hashed)
│   ├── shared/                 # Zod schemas for validation
│   ├── realtime/               # PG NOTIFY -> SSE bridge
│   ├── storage/                # Abstract StorageProvider with S3 implementation
│   └── mcp/                    # MCP server (39 tools, stdio + HTTP transport)
├── docker-compose.yml
├── turbo.json
└── package.json
```

**Key design decisions:**

- **Modular monorepo** -- pnpm workspaces + Turborepo for builds. Each package is independently importable
- **Event-sourced activity** -- every mutation logs an event. Agents and humans see the same audit trail
- **Container-based agent execution** -- Docker container sessions (SessionManager) for running Claude Code, Codex, or custom CLIs

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js >= 20 | Native fetch, stable ESM |
| Language | TypeScript 5.7+ | Type safety across monorepo |
| API Framework | Hono.js + OpenAPIHono | Fast, lightweight, edge-ready |
| ORM | Drizzle ORM | Type-safe SQL, zero overhead |
| Database | PostgreSQL 16 | JSONB for metadata, NOTIFY for real-time |
| Validation | Zod | Shared schemas between API, frontend, and MCP |
| Auth | API keys (SHA-256) | Simple, agent-friendly. No cookies or sessions |
| Real-time | PG NOTIFY -> SSE | No extra infra (no Redis, no WebSocket server) |
| Agent Protocol | MCP (Model Context Protocol) | Standard protocol for external AI agents |
| Frontend | React 19 + TanStack Router + TanStack Query | File-based routing, server state caching |
| Styling | Tailwind CSS 4 + shadcn/ui | Utility-first CSS with Radix UI primitives |
| Object Storage | S3-compatible (SeaweedFS for dev) | Agent file persistence (skills, learnings, memory) |
| Containers | Docker + dockerode | Ephemeral agent execution environments |
| Build | Turborepo | Parallel builds, dependency-aware caching |
| Linting | Biome | Fast, replaces ESLint + Prettier |

## Data Model

All product work is represented as **unified objects** -- insights, bets, and tasks share the same table with a `type` discriminator. This keeps the schema flat and lets agents reason across object types uniformly.

### Tables

| Table | Purpose |
|-------|---------|
| **actors** | Humans and AI agents. Both are first-class. Stores type, name, API key hash, system prompt, LLM config, and memory |
| **workspaces** | Isolated environments. Each workspace has its own settings including valid statuses per object type |
| **workspace_members** | Many-to-many join between actors and workspaces with roles (owner, member) |
| **objects** | The core table. Every insight, bet, and task is an object with: type, title, content, status, metadata (JSONB), and owner |
| **relationships** | Typed edges between objects: `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates` |
| **events** | Append-only activity log. Every mutation is recorded with actor, action, entity reference, and data payload |
| **triggers** | Automation rules. Either cron-based or event-based. Each trigger targets an actor and includes an action prompt |
| **integrations** | External service connections per workspace (OAuth-based) |
| **sessions** | Container-based agent execution sessions. Tracks lifecycle: pending -> running -> completed/paused/failed/timeout |
| **session_logs** | Append-only log output from container sessions (stdout/stderr/system), used for SSE streaming |
| **agent_files** | Metadata index for agent files stored in S3 (skills, learnings, memory) |

## API Endpoints

All endpoints are under `/api`. Most require `Authorization: Bearer <api-key>` and `X-Workspace-Id` headers.

### Health and Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/openapi.json` | OpenAPI spec (no auth) |

### Objects (Insights, Bets, Tasks)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/objects` | Create an object |
| GET | `/api/objects` | List objects (filter by type, status, owner) |
| GET | `/api/objects/search` | Search objects by text in title/content |
| GET | `/api/objects/:id` | Get object by ID |
| GET | `/api/objects/:id/graph` | Get object with all relationships and connected objects |
| PATCH | `/api/objects/:id` | Update object (title, content, status, metadata) |
| DELETE | `/api/objects/:id` | Delete object |

### Actors

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/actors` | Create actor and get API key (no auth) |
| GET | `/api/actors` | List actors (optionally filtered by workspace) |
| GET | `/api/actors/:id` | Get actor details |
| PATCH | `/api/actors/:id` | Update actor |
| POST | `/api/actors/:id/api-keys` | Regenerate API key |

### Workspaces

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List workspaces for current actor |
| PATCH | `/api/workspaces/:id` | Update workspace (name, settings) |
| POST | `/api/workspaces/:id/members` | Add member to workspace |
| GET | `/api/workspaces/:id/members` | List workspace members |

### Relationships

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relationships` | Create relationship between objects |
| GET | `/api/relationships` | List relationships (filter by source, target, type) |
| DELETE | `/api/relationships/:id` | Delete relationship |

### Triggers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/triggers` | Create automation trigger |
| GET | `/api/triggers` | List triggers in workspace |
| PATCH | `/api/triggers/:id` | Update trigger |
| DELETE | `/api/triggers/:id` | Delete trigger |

### Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | SSE stream of real-time events (supports `Last-Event-ID` for replay) |
| GET | `/api/events/history` | Paginated event history (filter by entity_type, action, since) |

### Sessions (Container-based Agent Execution)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions` | Create a container session |
| GET | `/api/sessions` | List sessions |
| GET | `/api/sessions/:id` | Get session details |
| POST | `/api/sessions/:id/stop` | Stop a running session |
| POST | `/api/sessions/:id/pause` | Pause and snapshot a session |
| POST | `/api/sessions/:id/resume` | Resume a paused session |
| GET | `/api/sessions/:id/logs` | Paginated log history |
| GET | `/api/sessions/:id/logs/stream` | SSE stream of live logs |

### Graph (Batch Operations)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/graph` | Atomic batch create (objects + relationships in one transaction) |

### Integrations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List integrations for workspace |
| GET | `/api/integrations/providers` | List available providers |
| POST | `/api/integrations/:provider/connect` | Start OAuth/connection flow |
| GET | `/api/integrations/:provider/callback` | OAuth callback (no auth) |
| DELETE | `/api/integrations/:id` | Disconnect integration |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/:provider` | Incoming webhook handler (no auth) |

### MCP HTTP Transport

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | Streamable HTTP transport for MCP clients |

## Agent System

Agents run as container sessions — ephemeral Docker containers running CLI agents (Claude Code, Codex, custom CLIs).

- **Triggered by events or cron** -- the TriggerRunner watches for matching events or schedules and spawns container sessions
- **All actions logged as events** -- every agent action appears in the event stream, attributed to the agent actor
- **Configurable per agent** -- each agent has its own system prompt, tools list, and persistent memory

- **Full lifecycle management** -- create, run, stop, pause (snapshot), resume
- **Live log streaming** -- stdout/stderr streamed via SSE in real-time
- **Persistent agent files** -- skills, learnings, and memory stored in S3-compatible storage, pulled into containers on start and pushed back on completion
- **Configurable** -- custom images, environment variables, timeouts, working directories

### External Agents (MCP)

External agents connect via the Model Context Protocol (39 tools available), supporting both stdio and HTTP transport.

- **Full workspace access** -- CRUD for objects, relationships, actors, workspaces, triggers, sessions, integrations
- **Works with any MCP-compatible client** -- Claude Code, Claude Desktop, OpenAI agents, custom implementations
- **Authenticated via API key** -- same auth as any other actor

## MCP Server Setup

To connect Claude Code (or any MCP client) to the workspace:

1. Create an actor to get an API key:
   ```bash
   curl -X POST http://localhost:3000/api/actors \
     -H "Content-Type: application/json" \
     -d '{"type": "agent", "name": "Claude Code"}'
   ```
   Save the `api_key` from the response.

2. Add to your MCP client config (e.g., `.claude/claude_desktop_config.json`):
   ```json
   {
     "mcpServers": {
       "ai-native-oss": {
         "command": "npx",
         "args": ["tsx", "packages/mcp/src/server.ts"],
         "env": {
           "API_BASE_URL": "http://localhost:3000",
           "API_KEY": "your-api-key",
           "WORKSPACE_ID": "your-workspace-id"
         }
       }
     }
   }
   ```

3. The agent can now create insights, propose bets, break down tasks, manage sessions, and query the event log -- all through tool calls.

## Docker

```bash
# Full stack (PostgreSQL + SeaweedFS + dev server)
docker-compose up

# Just the database and storage
docker-compose up postgres seaweedfs -d
```

The dev server container runs migrations on startup and serves at `http://localhost:3000`.

## Development

```bash
# Start everything (Docker + migrations + dev servers)
pnpm dev

# On Windows (cmd/PowerShell):
pnpm dev:win

# Build all packages
pnpm build

# Run tests
pnpm test

# Run E2E tests (requires running dev server)
pnpm test:e2e

# Lint (Biome)
pnpm lint

# Lint and auto-fix
pnpm lint:fix

# Format
pnpm format

# Type checking
pnpm type-check

# Database: generate migration from schema changes
pnpm db:generate

# Database: run pending migrations (automatically run by pnpm dev)
pnpm db:migrate

# Database: seed demo data
pnpm db:seed
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | -- | PostgreSQL connection string |
| `PORT` | No | `3000` | Server port |
| `S3_ENDPOINT` | No | `http://localhost:8333` | S3-compatible storage endpoint (SeaweedFS for dev) |
| `S3_BUCKET` | No | `agent-files` | Storage bucket name |
| `S3_ACCESS_KEY` | No | `admin` | S3 access key |
| `S3_SECRET_KEY` | No | `admin` | S3 secret key |
| `S3_REGION` | No | `us-east-1` | S3 region |

## License

Apache 2.0 — see [LICENSE](LICENSE) for details.
