---
sidebar_position: 3
title: "Tutorial: Automate with Triggers"
---

# Tutorial: Automate with Triggers

This tutorial shows how to set up triggers that fire agents automatically — either on a schedule or in response to events in the workspace.

**Time:** ~5 minutes

## Prerequisites

- Maskin running locally ([Quick Start](/quick-start))
- A workspace with an agent actor ([Tutorial: Connect an AI Agent](/tutorials/connect-ai-agent))

## What are triggers?

Triggers are automation rules. When a condition is met (a cron schedule or a workspace event), Maskin spawns a container session and runs the target agent with the specified prompt. This is how you build autonomous agent workflows.

## Example 1: Event trigger — Auto-triage new insights

When a new insight is created, have an agent automatically categorize it and decide whether it needs immediate attention.

### Create the triage agent

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Insight Triage Agent",
    "workspace_id": "your-workspace-id",
    "system_prompt": "You are an insight triage agent. When new insights come in, categorize them (bug, feature request, market signal, or feedback) by adding a category field to metadata. If the insight mentions a critical bug or affects many users, change its status to processing and create a notification for the team."
  }'
```

Save the agent's `id`.

### Create the event trigger

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Triage new insights",
    "type": "event",
    "config": {
      "entity_type": "object",
      "action": "created",
      "filter": { "type": "insight" }
    },
    "action_prompt": "A new insight was just created. Read it, categorize it (add category to metadata: bug, feature_request, market_signal, or feedback), and if it seems urgent, change status to processing and notify the team.",
    "target_actor_id": "triage-agent-id",
    "enabled": true
  }'
```

Now every time anyone (human or agent) creates an insight, the triage agent automatically processes it.

## Example 2: Cron trigger — Daily summary

Have an agent summarize the workspace activity every morning.

### Create the summary agent

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Daily Summary Agent",
    "workspace_id": "your-workspace-id",
    "system_prompt": "You are a daily summary agent. Generate concise summaries of workspace activity."
  }'
```

### Create the cron trigger

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily activity summary",
    "type": "cron",
    "config": {
      "expression": "0 9 * * *"
    },
    "action_prompt": "Summarize yesterdays workspace activity. Check the event log for all changes. Create an insight with type summary that covers: new insights received, bets proposed or completed, tasks started or finished, and any blockers. Keep it concise — bullet points, not paragraphs.",
    "target_actor_id": "summary-agent-id",
    "enabled": true
  }'
```

This runs every day at 9:00 AM.

## Example 3: Event trigger — Auto-assign tasks

When a task is moved to `todo` status, have an agent pick it up and start working.

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auto-assign todo tasks",
    "type": "event",
    "config": {
      "entity_type": "object",
      "action": "status_changed",
      "filter": { "type": "task", "status": "todo" }
    },
    "action_prompt": "A task just moved to todo status. Read the task description, understand the context by checking its parent bet, and start implementing it. Update the task status to in_progress when you begin.",
    "target_actor_id": "developer-agent-id",
    "enabled": true
  }'
```

## Managing triggers

### List all triggers
```bash
curl http://localhost:3000/api/triggers \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"
```

### Disable a trigger
```bash
curl -X PATCH http://localhost:3000/api/triggers/trigger-id \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Delete a trigger
```bash
curl -X DELETE http://localhost:3000/api/triggers/trigger-id \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"
```

## Monitoring trigger execution

When a trigger fires, it creates a container session. You can monitor these:

```bash
# List recent sessions
curl http://localhost:3000/api/sessions \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"

# Get logs from a specific session
curl http://localhost:3000/api/sessions/session-id/logs \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"
```

For real-time monitoring, use the SSE log stream:
```bash
curl -N http://localhost:3000/api/sessions/session-id/logs/stream \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"
```

## What's next?

- **[Core Concepts](/core-concepts)** — Deep dive into workspaces, objects, and the data model
- **[API Reference](/api-reference)** — Full reference for all tools and endpoints
