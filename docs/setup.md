# Set Up Maskin in 10 Minutes

Get a working Maskin workspace running locally — from zero to a populated demo in under 10 minutes.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| [Node.js](https://nodejs.org/) | >= 20 | `node -v` |
| [pnpm](https://pnpm.io/) | 9.15+ | `pnpm -v` |
| [Docker](https://www.docker.com/) | Any recent | `docker -v` |
| [Docker Compose](https://docs.docker.com/compose/) | v2+ | `docker compose version` |
| Git | Any | `git -v` |

> **Tip:** Install pnpm with `corepack enable && corepack prepare pnpm@latest --activate` (ships with Node.js).

## 1. Clone the repo

```bash
git clone https://github.com/sindre-ai/maskin.git
cd maskin
```

## 2. Install dependencies

```bash
pnpm install
```

This installs all packages across the monorepo (backend, frontend, shared libraries, MCP server).

## 3. Start everything

```bash
pnpm dev
```

This single command:
1. Starts **PostgreSQL** and **SeaweedFS** (S3-compatible storage) via Docker Compose
2. Runs pending **database migrations** automatically
3. Launches the **backend API** at `http://localhost:3000`
4. Launches the **frontend** at `http://localhost:5173`

> **Windows users:** Use `pnpm dev:win` instead (uses a Node.js script instead of bash).

### Verify it works

Open your browser to `http://localhost:5173` — you should see the Maskin UI.

You can also check the API health endpoint:

```bash
curl http://localhost:3000/api/health
```

## 4. Seed demo data (recommended)

Populate your workspace with a full demo of the Insight -> Bet -> Task cycle:

```bash
pnpm db:seed
```

This creates:
- A **Product Development** workspace with configured statuses
- **5 AI agents** (Insight Analyzer, Bet Planner, Senior Developer, Code Reviewer, Workspace Observer)
- **Automation triggers** wired to status changes
- **Sample insights, bets, and tasks** showing the full product development loop
- **Pre-populated events** so the activity feed has content

Refresh the frontend — you should see a living workspace with objects, agents, and activity.

## 5. Connect an MCP client (optional)

To connect Claude Code or another MCP-compatible client:

1. **Create an agent actor** to get an API key:

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{"type": "agent", "name": "My Agent"}'
```

Save the `api_key` from the response.

2. **Add to your MCP client config** (e.g., `.claude/settings.json`):

```json
{
  "mcpServers": {
    "maskin": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "env": {
        "API_BASE_URL": "http://localhost:3000",
        "API_KEY": "your-api-key-here",
        "WORKSPACE_ID": "your-workspace-id"
      }
    }
  }
}
```

The agent can now interact with your workspace through 39 MCP tools.

## Environment variables

All configuration is optional for local development — sensible defaults are provided.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | Auto-configured | PostgreSQL connection string |
| `PORT` | `3000` | Backend API port |
| `S3_ENDPOINT` | `http://localhost:8333` | S3-compatible storage (SeaweedFS) |
| `S3_BUCKET` | `agent-files` | Storage bucket name |
| `S3_ACCESS_KEY` | `admin` | S3 access key |
| `S3_SECRET_KEY` | `admin` | S3 secret key |

See the full list in the [CLAUDE.md](../CLAUDE.md#environment-variables) file.

## Common commands

```bash
pnpm dev          # Start everything (Docker + migrations + servers)
pnpm build        # Build all packages
pnpm test         # Run all tests
pnpm lint         # Lint with Biome
pnpm type-check   # TypeScript type checking
pnpm db:seed      # Seed demo data
pnpm db:migrate   # Run database migrations manually
```

## Troubleshooting

**Docker not running?**
`pnpm dev` requires Docker for PostgreSQL and SeaweedFS. Make sure Docker Desktop (or the Docker daemon) is running before you start.

**Port conflict on 3000 or 5173?**
Stop any other services using those ports, or set `PORT=3001` in your environment.

**Database connection errors?**
The dev script waits for PostgreSQL to be ready, but if you see connection errors, try `docker compose down && pnpm dev` to restart cleanly.

## Next steps

- [Create your first agent team](./create-agent-team.md) — set up agents, triggers, and the automation loop
- [Build an extension](./build-extension.md) — create custom object types with the module SDK
- [API Reference](./api-reference.md) — full endpoint documentation
- [Data Model](./data-model.md) — database schema and table reference
