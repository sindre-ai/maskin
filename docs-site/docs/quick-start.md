---
sidebar_position: 2
title: Quick Start
---

# Quick Start

Go from zero to a working Maskin workspace with agents in 5 minutes.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 20
- [Docker](https://www.docker.com/) (for PostgreSQL and SeaweedFS)
- [pnpm](https://pnpm.io/) 9.15+

## 1. Clone and install

```bash
git clone https://github.com/sindre-ai/maskin.git
cd maskin
pnpm install
```

## 2. Start everything

```bash
pnpm dev
```

This single command:
- Starts PostgreSQL and SeaweedFS via Docker
- Runs database migrations
- Launches the backend API server (port 3000)
- Launches the frontend (port 5173)

On Windows (cmd/PowerShell), use `pnpm dev:win` instead.

## 3. Verify it's running

- **Backend:** Open [http://localhost:3000/api/health](http://localhost:3000/api/health) — you should see a health check response
- **Frontend:** Open [http://localhost:5173](http://localhost:5173) — the Maskin UI

## 4. Create your first actor

Every user (human or agent) in Maskin is an **actor**. Create one to get an API key:

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{"type": "human", "name": "Your Name"}'
```

Save the `api_key` from the response — you'll need it for authenticated requests.

## 5. Seed demo data (optional)

To explore Maskin with pre-built example data:

```bash
pnpm db:seed
```

This creates sample workspaces, objects, relationships, and agents so you can see the system in action immediately.

## 6. Connect an AI agent

Maskin uses the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) so external AI agents can operate the workspace natively.

### Connect Claude Code

Add to your Claude Code MCP config (`.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "your-api-key-from-step-4",
        "WORKSPACE_ID": "your-workspace-id"
      }
    }
  }
}
```

### Connect via HTTP (any MCP client)

For remote or HTTP-based MCP clients, use the streamable HTTP transport:

```
POST http://localhost:3000/mcp
Authorization: Bearer your-api-key
X-Workspace-Id: your-workspace-id
```

The agent can now create insights, propose bets, break down tasks, manage sessions, and query the event log — all through MCP tool calls.

## Next steps

- **[Core Concepts](/core-concepts)** — Understand the building blocks
- **[Tutorial: Set up a product development workspace](/tutorials/product-development-workspace)** — End-to-end walkthrough
- **[API Reference](/api-reference)** — All available tools and endpoints
