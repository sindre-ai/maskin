---
sidebar_position: 2
title: "Tutorial: Connect an AI Agent"
---

# Tutorial: Connect an AI Agent via MCP

This tutorial shows how to connect an external AI agent (like Claude Code) to your Maskin workspace using the Model Context Protocol (MCP).

**Time:** ~5 minutes

## Prerequisites

- Maskin running locally ([Quick Start](/quick-start))
- A workspace with an API key ([Tutorial: Product Development Workspace](/tutorials/product-development-workspace))
- An MCP-compatible AI client (Claude Code, Claude Desktop, etc.)

## Step 1: Create an agent actor

Create a dedicated actor for your AI agent:

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{
    "type": "agent",
    "name": "Product Analyst",
    "workspace_id": "your-workspace-id",
    "system_prompt": "You are a product analyst agent. Your job is to review insights in the workspace, identify patterns, and propose bets (experiments) the team should run. Be data-driven and concise."
  }'
```

Save the `api_key` from the response.

## Step 2: Configure the MCP connection

### Option A: Claude Code (stdio transport)

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "agent-api-key-from-step-1",
        "WORKSPACE_ID": "your-workspace-id"
      }
    }
  }
}
```

### Option B: HTTP transport (any MCP client)

For clients that support HTTP MCP transport, point them to:

```
URL: http://localhost:3000/mcp
Headers:
  Authorization: Bearer agent-api-key-from-step-1
  X-Workspace-Id: your-workspace-id
```

## Step 3: Verify the connection

Once connected, ask the agent to call the `hello` tool. It should return an overview of your workspace including:
- Available object types and their statuses
- Custom metadata fields
- Team members
- Available tools

Example prompt to the agent:
> "Call the hello tool to see what's in this workspace."

## Step 4: Let the agent work

Now the agent can operate the workspace through MCP tools. Try these prompts:

### List insights
> "List all insights in the workspace that are in 'new' status."

The agent will call `list_objects` with `type: "insight"` and `status: "new"`.

### Analyze and create a bet
> "Review the new insights, find patterns, and propose a bet if there's enough signal."

The agent will:
1. Call `list_objects` to read insights
2. Analyze the content
3. Call `create_objects` to create a bet with relationships to the relevant insights

### Search for specific topics
> "Search for any objects mentioning 'performance' or 'loading time'."

The agent will call `search_objects` with relevant queries.

## Step 5: Review agent actions

Every action the agent takes is recorded in the event log, attributed to the agent actor:

```bash
curl "http://localhost:3000/api/events/history?limit=10" \
  -H "Authorization: Bearer your-human-api-key" \
  -H "X-Workspace-Id: your-workspace-id"
```

You'll see events like `object.created` attributed to "Product Analyst" — full transparency into what the agent did.

## What's next?

- **[Automate with triggers](/tutorials/automate-with-triggers)** — Make agents react to events automatically
- **[API Reference](/api-reference)** — See all 39 MCP tools available to agents
