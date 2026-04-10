---
sidebar_position: 4
title: API Reference
---

# API Reference

Maskin exposes two interfaces: a **REST API** and an **MCP server** (Model Context Protocol). Both provide the same capabilities — use REST for direct HTTP integrations, MCP for AI agent integrations.

## Authentication

All authenticated endpoints require:
- `Authorization: Bearer <api-key>` — Your actor's API key
- `X-Workspace-Id: <workspace-id>` — The workspace to operate in

Create an actor to get an API key:
```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{"type": "human", "name": "Your Name"}'
```

---

## MCP Tools

The MCP server exposes 39 tools that AI agents can use to operate the workspace. Connect via stdio or HTTP transport.

### Welcome

| Tool | Description |
|------|-------------|
| `hello` | Get an overview of the workspace — object types, statuses, custom fields, team members, and available tools. Start here. |

### Objects (Insights, Bets, Tasks)

| Tool | Description |
|------|-------------|
| `create_objects` | Create one or more objects with optional relationships in a single atomic operation. Use `$id` references in edges to link new objects together. |
| `get_objects` | Get one or more objects by ID with all relationships and connected objects. |
| `update_objects` | Update one or more objects (title, content, status, metadata) and/or create relationships between existing objects. |
| `delete_object` | Delete an object by ID. |
| `list_objects` | List objects filtered by type, status, or owner. Returns paginated results. |
| `search_objects` | Search objects by text in title or content, with optional type/status filters. |

### Relationships

| Tool | Description |
|------|-------------|
| `list_relationships` | List relationships with optional filters (source_id, target_id, type). |
| `delete_relationship` | Delete a relationship by ID. |

### Actors

| Tool | Description |
|------|-------------|
| `create_actor` | Create a new actor (human or agent) and optionally add them to a workspace. Returns the API key (shown once). |
| `update_actor` | Update an actor's name, email, system prompt, tools, memory, or LLM config. |
| `regenerate_api_key` | Regenerate an actor's API key. Returns the new key (shown once). |
| `list_actors` | List all actors (humans and agents) in the workspace with their roles. |
| `get_actor` | Get actor details by ID. |

### Workspaces

| Tool | Description |
|------|-------------|
| `create_workspace` | Create a new workspace. The authenticated actor becomes the owner. |
| `update_workspace` | Update a workspace's name and/or settings. |
| `list_workspaces` | List workspaces accessible to the authenticated actor. |
| `get_workspace_schema` | Get the workspace schema: statuses per type, custom metadata fields, display names, and relationship types. |
| `add_workspace_member` | Add an existing actor to a workspace with a role (owner, admin, member). |

### Triggers

| Tool | Description |
|------|-------------|
| `create_trigger` | Create a cron or event-based trigger that fires an agent. |
| `update_trigger` | Update a trigger's name, config, prompt, target agent, or enabled state. |
| `delete_trigger` | Delete a trigger by ID. |
| `list_triggers` | List all triggers in the workspace. |

### Sessions

| Tool | Description |
|------|-------------|
| `create_session` | Spawn a containerized agent execution session. Creates an ephemeral Docker container running the specified agent. |
| `list_sessions` | List sessions with optional status/actor filters. |
| `get_session` | Get session details by ID, optionally including log output. |
| `stop_session` | Stop a running session. |
| `pause_session` | Pause a running session and save a snapshot. |
| `resume_session` | Resume a previously paused session from its snapshot. |
| `run_agent` | High-level blocking tool: create a session, wait for completion, return results with logs. |

### Notifications

| Tool | Description |
|------|-------------|
| `create_notification` | Create a notification for a human — for decisions needed, recommendations, good news, or alerts. |
| `list_notifications` | List notifications filtered by status or type. |
| `get_notification` | Get a single notification by ID. |
| `update_notification` | Update a notification's status (pending, seen, resolved, dismissed) or metadata. |
| `delete_notification` | Delete a notification by ID. |

### Events

| Tool | Description |
|------|-------------|
| `get_events` | Get the workspace activity log. Filter by entity_type and action. |

### Integrations

| Tool | Description |
|------|-------------|
| `list_integrations` | List integrations connected to the workspace. |
| `list_integration_providers` | List available integration providers and their supported events. |
| `connect_integration` | Start an OAuth connection flow for a provider. Returns an install URL. |
| `disconnect_integration` | Disconnect an integration by ID. |

### Extensions

| Tool | Description |
|------|-------------|
| `list_extensions` | List all available extensions and their status in the workspace. |
| `create_extension` | Add an extension — enable a built-in one (e.g., `work`) or create a custom extension with new object types. |
| `update_extension` | Enable/disable an extension or update its object type definitions. |
| `delete_extension` | Remove an extension from the workspace. |

---

## REST API

All endpoints are under `/api`. The OpenAPI spec is available at `GET /api/openapi.json`.

### Public (no auth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/openapi.json` | OpenAPI specification |
| POST | `/api/actors` | Create actor (signup) — returns API key |

### Objects

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/objects` | Create an object |
| GET | `/api/objects` | List objects (filter by `type`, `status`, `owner`) |
| GET | `/api/objects/search` | Search by text in title/content |
| GET | `/api/objects/:id` | Get object by ID |
| GET | `/api/objects/:id/graph` | Get object with all relationships and connected objects |
| PATCH | `/api/objects/:id` | Update object |
| DELETE | `/api/objects/:id` | Delete object |

### Actors

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/actors` | List actors |
| GET | `/api/actors/:id` | Get actor by ID |
| PATCH | `/api/actors/:id` | Update actor |
| POST | `/api/actors/:id/api-keys` | Regenerate API key |

### Workspaces

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workspaces` | Create workspace |
| GET | `/api/workspaces` | List workspaces for current actor |
| PATCH | `/api/workspaces/:id` | Update workspace |
| POST | `/api/workspaces/:id/members` | Add member to workspace |
| GET | `/api/workspaces/:id/members` | List workspace members |

### Relationships

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/relationships` | Create relationship |
| GET | `/api/relationships` | List relationships (filter by `source_id`, `target_id`, `type`) |
| DELETE | `/api/relationships/:id` | Delete relationship |

### Triggers

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/triggers` | Create trigger |
| GET | `/api/triggers` | List triggers |
| PATCH | `/api/triggers/:id` | Update trigger |
| DELETE | `/api/triggers/:id` | Delete trigger |

### Events

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events` | SSE stream of real-time events (supports `Last-Event-ID`) |
| GET | `/api/events/history` | Paginated event history |

### Sessions

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

### Graph

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/graph` | Atomic batch create (objects + relationships in one transaction) |

### Integrations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/integrations` | List integrations |
| GET | `/api/integrations/providers` | List available providers |
| POST | `/api/integrations/:provider/connect` | Start OAuth flow |
| GET | `/api/integrations/:provider/callback` | OAuth callback |
| DELETE | `/api/integrations/:id` | Disconnect integration |

### MCP HTTP Transport

| Method | Path | Description |
|--------|------|-------------|
| POST | `/mcp` | Streamable HTTP transport for MCP clients |
