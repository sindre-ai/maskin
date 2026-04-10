---
sidebar_position: 3
title: Core Concepts
---

# Core Concepts

Maskin has a small number of building blocks that compose into powerful workflows. Here's what each one does.

## Workspaces

A workspace is an isolated environment where a team operates. Each workspace has its own objects, actors, triggers, and settings. Think of it as a project or organization boundary.

Workspaces are configurable — you can define custom object types, statuses, metadata fields, and display names per workspace. This means one workspace might track `insights → bets → tasks` while another tracks `leads → deals → contracts`.

```bash
# Create a workspace
curl -X POST http://localhost:3000/api/workspaces \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "My Product Team"}'
```

## Objects

Everything in Maskin is an **object**. Insights, bets, tasks — they all share the same unified data model with a `type` field to distinguish them. This keeps the system simple and lets agents reason across object types uniformly.

Every object has:
- **type** — `insight`, `bet`, `task`, or any custom type defined via extensions
- **title** — A short name
- **content** — Detailed description (supports Markdown)
- **status** — Configurable per type (e.g., tasks: `todo → in_progress → done`)
- **metadata** — Flexible key-value data (JSONB) for custom fields

**Default object types:**
| Type | Purpose | Default statuses |
|------|---------|-----------------|
| Insight | Raw feedback, signals, observations | `new`, `processing`, `clustered`, `discarded` |
| Bet | Hypotheses to validate, experiments to run | `signal`, `proposed`, `active`, `completed`, `succeeded`, `failed`, `paused` |
| Task | Concrete work items | `todo`, `in_progress`, `done`, `blocked` |

## Relationships

Relationships are typed edges between objects. They form a graph that represents how work flows through the system.

| Type | Meaning | Example |
|------|---------|---------|
| `informs` | Insight provides evidence for a bet | "50 users asked for X" → "Build feature X" |
| `breaks_into` | Bet decomposes into tasks | "Build feature X" → "Design API", "Write tests" |
| `blocks` | One item blocks another | "Fix auth bug" blocks "Deploy v2" |
| `relates_to` | General association | Two related insights |
| `duplicates` | Marks a duplicate | Insight A duplicates Insight B |

## Actors

An actor is any entity that can operate in a workspace — either a **human** or an **agent**. Both are first-class citizens with the same identity model, API access, and permissions.

Agents have additional configuration:
- **system_prompt** — Instructions that define the agent's behavior
- **tools** — Which MCP tools the agent can use
- **memory** — Persistent key-value store for the agent's learnings
- **llm_provider / llm_config** — Which LLM to use and how to configure it

Every mutation in the system is attributed to the actor who performed it, creating a complete audit trail.

## Triggers

Triggers are automation rules that fire agents. There are two types:

### Cron triggers
Run on a schedule. Useful for periodic tasks like "summarize daily activity" or "check for stale tasks."

```json
{
  "name": "Daily summary",
  "type": "cron",
  "config": { "expression": "0 9 * * *" },
  "action_prompt": "Summarize yesterday's activity and post to #general",
  "target_actor_id": "agent-uuid"
}
```

### Event triggers
Fire when something happens in the workspace. Useful for reactive workflows like "when a task is created, assign it to an agent."

```json
{
  "name": "Auto-assign new tasks",
  "type": "event",
  "config": {
    "entity_type": "object",
    "action": "created",
    "filter": { "type": "task" }
  },
  "action_prompt": "Review this new task and start working on it",
  "target_actor_id": "agent-uuid"
}
```

## Sessions

Sessions are ephemeral Docker containers where agents execute work. When a trigger fires (or you manually create a session), Maskin spins up a container running Claude Code, Codex, or a custom CLI.

Sessions support:
- **Full lifecycle management** — create, run, stop, pause (snapshot), resume
- **Live log streaming** — stdout/stderr streamed via SSE in real-time
- **Persistent agent files** — skills, learnings, and memory stored in S3, pulled in on start and pushed back on completion
- **Configurable resources** — custom images, environment variables, timeouts, memory limits

## Extensions

Extensions let you add custom object types to a workspace. Maskin ships with a built-in `work` extension (insights, bets, tasks), but you can create your own for any domain.

```bash
# Create a custom CRM extension
curl -X POST http://localhost:3000/api/extensions \
  -H "Authorization: Bearer your-api-key" \
  -H "X-Workspace-Id: your-workspace-id" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "crm",
    "name": "CRM",
    "object_types": [
      {
        "type": "lead",
        "display_name": "Lead",
        "statuses": ["new", "contacted", "qualified", "converted", "lost"],
        "fields": [
          {"name": "company", "type": "text", "required": true},
          {"name": "value", "type": "number"},
          {"name": "source", "type": "enum", "values": ["inbound", "outbound", "referral"]}
        ]
      }
    ]
  }'
```

## Events

Every mutation in Maskin is recorded as an event in an append-only log. Events power:
- **Real-time updates** — The frontend uses Server-Sent Events (SSE) to show live changes
- **Audit trail** — See who changed what, when, and why
- **Event triggers** — Agents react to changes automatically
- **Replay** — Catch up on what happened while you were away

Events include the actor, action (`created`, `updated`, `deleted`, `status_changed`), entity reference, and full data payload.

## Integrations

Maskin connects to external services via OAuth integrations. Once connected, agents can use the integration's capabilities through MCP tools.

Supported integrations include services like GitHub, Slack, Google Calendar, and more. Each integration follows a standard OAuth2 flow — connect once, and agents get access automatically.
