# API Reference

All endpoints are under `/api`. Most require `Authorization: Bearer <api-key>` and `X-Workspace-Id` headers.

The full OpenAPI spec is available at `GET /api/openapi.json`.

## Authentication

Maskin uses API key authentication. Include your key in the `Authorization` header:

```
Authorization: Bearer ank_your-api-key-here
```

For workspace-scoped endpoints, also include:

```
X-Workspace-Id: your-workspace-uuid
```

All write endpoints accept an optional `Idempotency-Key` header for safe retries.

## Health and Metadata

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/openapi.json` | OpenAPI spec (no auth) |

## Objects (Insights, Bets, Tasks)

Objects are the core data type. Insights, bets, tasks, and any custom extension types all share the same endpoints.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/objects` | Create an object |
| GET | `/api/objects` | List objects (filter by type, status, owner) |
| GET | `/api/objects/search` | Search objects by text in title/content |
| GET | `/api/objects/:id` | Get object by ID |
| GET | `/api/objects/:id/graph` | Get object with all relationships and connected objects |
| PATCH | `/api/objects/:id` | Update object (title, content, status, metadata) |
| DELETE | `/api/objects/:id` | Delete object |

### Example: Create an object

```bash
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer {api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "Users want dark mode",
    "content": "Mentioned 5 times in feedback this month",
    "status": "new"
  }'
```

## Actors

Actors represent both humans and AI agents.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/actors` | Create actor and get API key (no auth) |
| GET | `/api/actors` | List actors (optionally filtered by workspace) |
| GET | `/api/actors/:id` | Get actor details |
| PATCH | `/api/actors/:id` | Update actor |
| POST | `/api/actors/:id/api-keys` | Regenerate API key |

## Workspaces

Workspaces are isolated environments with their own settings, members, and objects.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List workspaces for current actor |
| PATCH | `/api/workspaces/:id` | Update workspace (name, settings) |
| POST | `/api/workspaces/:id/members` | Add member to workspace |
| GET | `/api/workspaces/:id/members` | List workspace members |

## Relationships

Typed edges between objects. Relationship types: `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relationships` | Create relationship between objects |
| GET | `/api/relationships` | List relationships (filter by source, target, type) |
| DELETE | `/api/relationships/:id` | Delete relationship |

## Triggers

Automation rules that fire agents based on events or schedules.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/triggers` | Create automation trigger |
| GET | `/api/triggers` | List triggers in workspace |
| PATCH | `/api/triggers/:id` | Update trigger |
| DELETE | `/api/triggers/:id` | Delete trigger |

## Events

Real-time event stream and history. Every mutation in the workspace is logged as an event.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | SSE stream of real-time events (supports `Last-Event-ID` for replay) |
| GET | `/api/events/history` | Paginated event history (filter by entity_type, action, since) |

## Sessions (Container-based Agent Execution)

Sessions are Docker containers that run agent CLIs (Claude Code, Codex, custom tools).

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

## Graph (Batch Operations)

Atomic batch creation of objects and relationships in a single transaction.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/graph` | Atomic batch create (objects + relationships in one transaction) |

## Integrations

External service connections (OAuth-based).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List integrations for workspace |
| GET | `/api/integrations/providers` | List available providers |
| POST | `/api/integrations/:provider/connect` | Start OAuth/connection flow |
| GET | `/api/integrations/:provider/callback` | OAuth callback (no auth) |
| DELETE | `/api/integrations/:id` | Disconnect integration |

## Webhooks

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/:provider` | Incoming webhook handler (no auth) |

## MCP HTTP Transport

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | Streamable HTTP transport for MCP clients |
