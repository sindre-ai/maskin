<p align="center">
  <h1 align="center">Maskin</h1>
  <p align="center">An open-source workspace where AI agents run product development.<br/>Insights in, shipped features out.</p>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7+-blue.svg" alt="TypeScript"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%3E%3D20-green.svg" alt="Node"></a>
</p>

---

## What is Maskin?

Maskin is a **product development workspace** where AI agents do the work. Humans set direction. Agents analyze signals, propose strategies, break down work, write code, review PRs, and improve the system itself.

Everything follows one loop:

```
Insights  -->  Bets  -->  Tasks  -->  Feedback  -->  Insights
   |              |            |                         |
 signals      hypotheses   execution              the loop closes
```

- **Insights** are signals from users, data, competitors, or the system itself
- **Bets** are hypotheses worth validating — proposed by agents, approved by humans
- **Tasks** are concrete work items — agents execute them autonomously
- **The loop closes** when a Workspace Observer agent generates meta-insights about what happened, feeding the next cycle

This isn't another AI framework. It's a self-improving product development OS.

## Demo

<!-- TODO: Replace with actual demo video/GIF after Task 7 -->

> Run `pnpm db:seed` to see Maskin in action. The seed populates a full Product Development workspace with agents, triggers, insights, bets, and tasks — showing the complete Insight > Bet > Task cycle.

The demo seed includes:
- **5 AI agents** — Insight Analyzer, Bet Planner, Senior Developer, Code Reviewer, Workspace Observer
- **Automated triggers** — agents fire on status changes and cron schedules
- **Sample objects** — insights, bets, and tasks in various stages of the pipeline
- **Meta-insights** — the Workspace Observer analyzing its own system, demonstrating the self-improving loop

## Quick Start

```bash
# Clone and install
git clone https://github.com/sindre-ai/maskin.git && cd maskin
pnpm install

# Seed the demo workspace
pnpm db:seed

# Start everything (Docker, migrations, backend + frontend)
pnpm dev
```

> On Windows, use `pnpm dev:win` instead.

Backend runs at `http://localhost:3000` (`/api/health` to verify). Frontend at `http://localhost:5173`.

## How It Works

Maskin runs on a simple loop that compounds over time:

1. **Insights arrive** — from integrations, user feedback, agent observations, or manual entry
2. **Agents analyze** — the Insight Analyzer clusters signals and identifies patterns
3. **Bets get proposed** — the Bet Planner turns patterns into strategic hypotheses with success criteria
4. **Tasks get created** — bets break down into concrete, executable tasks
5. **Agents execute** — the Senior Developer writes code, the Code Reviewer reviews PRs
6. **The system observes itself** — the Workspace Observer creates meta-insights about what worked and what didn't

Humans stay in the loop at decision points: approving bets, course-correcting priorities, reviewing critical work. Everything else runs autonomously.

## Architecture

```
maskin/
├── apps/
│   ├── dev/                    # Backend API (Hono.js)
│   │   └── src/
│   │       ├── routes/         # REST endpoints
│   │       ├── services/       # Trigger runner, session manager, containers
│   │       └── lib/            # LLM adapters, integrations
│   ├── web/                    # Frontend (React + TanStack)
│   │   └── src/
│   │       ├── routes/         # File-based routing
│   │       ├── components/     # UI components
│   │       └── hooks/          # Data fetching
│   └── e2e/                    # E2E tests (Playwright)
├── packages/
│   ├── db/                     # Drizzle ORM schema + migrations
│   ├── auth/                   # API key auth (SHA-256)
│   ├── shared/                 # Zod validation schemas
│   ├── realtime/               # PG NOTIFY -> SSE bridge
│   ├── storage/                # S3-compatible file storage
│   └── mcp/                    # MCP server (39 tools, stdio + HTTP)
├── extensions/                 # Custom object types via module system
├── scripts/                    # Dev startup scripts
├── docker-compose.yml
├── turbo.json
└── package.json
```

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js >= 20 | Native fetch, stable ESM |
| Language | TypeScript 5.7+ | Type safety across monorepo |
| API | Hono.js + OpenAPIHono | Fast, lightweight, edge-ready |
| Database | PostgreSQL 16 + Drizzle ORM | JSONB metadata, PG NOTIFY for real-time |
| Validation | Zod | Shared schemas across API, frontend, MCP |
| Auth | API keys (SHA-256) | Simple, agent-friendly — no cookies or sessions |
| Real-time | PG NOTIFY -> SSE | No extra infra needed |
| Agent Protocol | MCP (Model Context Protocol) | Standard protocol for AI agents |
| Frontend | React 19 + TanStack Router/Query | File-based routing, server state caching |
| Styling | Tailwind CSS 4 + shadcn/ui | Utility-first with Radix primitives |
| Storage | S3-compatible (SeaweedFS for dev) | Agent file persistence |
| Containers | Docker + dockerode | Ephemeral agent execution environments |
| Build | Turborepo + pnpm workspaces | Parallel builds, dependency-aware caching |
| Linting | Biome | Fast, replaces ESLint + Prettier |

## MCP Setup

Maskin exposes 39 tools via the [Model Context Protocol](https://modelcontextprotocol.io/), so any MCP-compatible client can interact with the workspace.

**1. Create an actor to get an API key:**

```bash
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{"type": "agent", "name": "My Agent"}'
```

**2. Add to your MCP client config** (e.g., Claude Code, Claude Desktop):

```json
{
  "mcpServers": {
    "maskin": {
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

**3. Your agent can now** create insights, propose bets, break down tasks, manage sessions, and query the event log — all through tool calls.

## Contributing

We welcome contributions! Here's how to get started:

```bash
# Fork and clone
git clone https://github.com/your-username/maskin.git && cd maskin
pnpm install

# Start the dev environment
pnpm dev

# Run checks before committing
pnpm lint
pnpm type-check
pnpm test -- --run
```

Please open an issue first for significant changes. PRs should be focused and include tests where applicable.

## License

[Apache 2.0](LICENSE) — use it, modify it, ship it. The explicit patent grant protects both the project and users.

## What's Next

- [ ] Demo video showing the full Insight > Bet > Task > Meta-insight loop
- [ ] Comprehensive docs (setup guide, agent team guide, extension guide)
- [ ] More integration providers (Slack, Linear, GitHub, Google Calendar)
- [ ] Plugin marketplace for community extensions
- [ ] Hosted version for teams who don't want to self-host

---

<p align="center">
  <strong>Built by <a href="https://github.com/sindre-ai">Sindre AI</a></strong><br/>
  Star the repo if you believe product development should run itself.
</p>
