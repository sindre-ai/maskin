# Create Your First Agent Team

This guide walks you through setting up a team of AI agents that automate the Insight -> Bet -> Task product development loop in Maskin.

By the end, you'll have agents that automatically analyze insights, plan bets, and execute tasks — triggered by status changes in your workspace.

## Prerequisites

- Maskin running locally (`pnpm dev`) — see [Set up in 10 minutes](./setup.md)
- A workspace created (the seed script creates one, or create your own via the UI)

## Concepts

| Concept | What it is |
|---------|------------|
| **Actor** | A human or AI agent. Both use the same identity model and API |
| **Trigger** | An automation rule that fires when an event occurs (status change) or on a cron schedule |
| **Session** | A container-based execution environment where an agent runs (Docker container with CLI tools) |
| **Object** | An insight, bet, or task — the units of work in the product development loop |

## Step 1: Create agent actors

Each agent needs an actor identity. Create them via the API:

```bash
# Insight Analyzer — processes new insights
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Insight Analyzer",
    "systemPrompt": "You analyze customer insights and determine their priority and relevance. When an insight is accepted, you cluster it with related insights and suggest whether it warrants a bet."
  }'

# Bet Planner — breaks bets into tasks
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Bet Planner",
    "systemPrompt": "You take active bets and break them into concrete, actionable tasks. Each task should be small enough for a single agent to complete."
  }'

# Senior Developer — implements tasks
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Senior Developer",
    "systemPrompt": "You implement tasks by writing code, creating branches, and submitting pull requests. Write production-quality code that follows existing patterns."
  }'

# Code Reviewer — reviews completed work
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Code Reviewer",
    "systemPrompt": "You review pull requests for code quality, correctness, and alignment with the task requirements. Approve or request changes."
  }'
```

Save the `id` and `api_key` from each response — you'll need them for trigger setup.

> **Tip:** You can also create actors through the Maskin UI under the Agents section.

## Step 2: Add agents to your workspace

Each agent needs workspace membership:

```bash
curl -X POST http://localhost:3000/api/workspaces/{workspace-id}/members \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{"actorId": "{agent-actor-id}", "role": "member"}'
```

Repeat for each agent actor.

## Step 3: Create automation triggers

Triggers wire agents to workspace events. When an object's status changes, the matching trigger fires and spawns an agent session.

### Insight accepted -> Insight Analyzer

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Analyze accepted insights",
    "type": "event",
    "enabled": true,
    "actorId": "{insight-analyzer-id}",
    "config": {
      "entityType": "object",
      "action": "status_changed",
      "conditions": {
        "objectType": "insight",
        "newStatus": "accepted"
      }
    },
    "actionPrompt": "An insight has been accepted. Read it, analyze its priority, and cluster it with related insights. If there are enough signals, propose a bet."
  }'
```

### Bet activated -> Bet Planner

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Plan active bets",
    "type": "event",
    "enabled": true,
    "actorId": "{bet-planner-id}",
    "config": {
      "entityType": "object",
      "action": "status_changed",
      "conditions": {
        "objectType": "bet",
        "newStatus": "active"
      }
    },
    "actionPrompt": "A bet has been activated. Read the bet and its linked insights. Break it into 3-8 concrete tasks with clear descriptions and acceptance criteria."
  }'
```

### Task moved to todo -> Senior Developer

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Implement todo tasks",
    "type": "event",
    "enabled": true,
    "actorId": "{senior-developer-id}",
    "config": {
      "entityType": "object",
      "action": "status_changed",
      "conditions": {
        "objectType": "task",
        "newStatus": "todo"
      }
    },
    "actionPrompt": "A task is ready for implementation. Read the task, understand its parent bet, check dependencies, then implement the solution."
  }'
```

### Task in review -> Code Reviewer

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Review tasks in review",
    "type": "event",
    "enabled": true,
    "actorId": "{code-reviewer-id}",
    "config": {
      "entityType": "object",
      "action": "status_changed",
      "conditions": {
        "objectType": "task",
        "newStatus": "in_review"
      }
    },
    "actionPrompt": "A task is ready for review. Find the PR link in the task description, review the code for quality and correctness, and approve or request changes."
  }'
```

## Step 4: Add a cron trigger (optional)

Create a Workspace Observer that runs daily to reflect on workspace activity:

```bash
curl -X POST http://localhost:3000/api/triggers \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily workspace observation",
    "type": "cron",
    "enabled": true,
    "actorId": "{observer-agent-id}",
    "config": {
      "schedule": "0 9 * * *"
    },
    "actionPrompt": "Review the workspace activity from the last 24 hours. Create a meta-insight summarizing what happened, what worked, and what could be improved."
  }'
```

This creates the self-improving loop — the observer creates insights about the workspace itself, which can feed back into the Insight -> Bet -> Task cycle.

## Step 5: Test the loop

1. **Create an insight** in the UI or via the API:

```bash
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "Users are asking for dark mode",
    "content": "Multiple user feedback sessions mention wanting a dark theme. This has come up 5 times in the last month.",
    "status": "new"
  }'
```

2. **Accept the insight** — change its status to `accepted`:

```bash
curl -X PATCH http://localhost:3000/api/objects/{insight-id} \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}" \
  -H "Content-Type: application/json" \
  -d '{"status": "accepted"}'
```

3. **Watch the chain reaction** — the Insight Analyzer trigger fires, creating a session. Check the Events tab in the UI or stream events:

```bash
curl -N http://localhost:3000/api/events \
  -H "Authorization: Bearer {your-api-key}" \
  -H "X-Workspace-Id: {workspace-id}"
```

When the agent proposes and activates a bet, the Bet Planner fires next, breaking it into tasks. When tasks move to `todo`, the Senior Developer picks them up.

## How it works under the hood

1. **Event fires** — when an object status changes, the backend emits an event
2. **TriggerRunner matches** — the trigger runner checks all enabled triggers against the event
3. **Session spawned** — a matching trigger creates a Docker container session for the assigned agent
4. **Agent executes** — the container runs the agent CLI (e.g., Claude Code) with the action prompt and workspace MCP access
5. **Results logged** — all agent actions appear as events in the workspace activity feed

## Next steps

- [Build an extension](./build-extension.md) — create custom object types for your domain
- [API Reference](./api-reference.md) — full endpoint documentation
- [Data Model](./data-model.md) — understand the underlying schema
