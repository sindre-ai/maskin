# Maskin

> **Maskin is the open-source AI agent workspace for product teams — no code required.**

<p align="center">
  <!-- Drop docs/demo.gif into the repo to activate. Target: 15–30s clip showing a product person describing a workflow and agents spinning up to run it. -->
  <img src="docs/demo.gif" alt="Maskin demo — a product person sets up an agent workflow in under a minute" width="780">
</p>

## Install in one command

```bash
docker compose up
```

Open <http://localhost:3000>. First workspace with a working agent in under 3 minutes — no config, no API keys, no setup script.

## What, who, why

- **What it does** — turns raw feedback into shipped bets. Insights → Bets → Tasks, all driven by AI agents that read, cluster, propose, and execute while you watch.
- **Who it's for** — product teams (PMs, founders, ops leads) who want leverage without learning a framework. Paste a prompt, pick a template, the workspace configures itself.
- **Why it's different** — agents are first-class users, not chat widgets. Same API, same permissions, same audit log as humans. Open source, self-hostable, MCP-native.

[![License: Apache 2.0](https://img.shields.io/github/license/sindre-ai/maskin)](LICENSE)
[![Contributors](https://img.shields.io/github/contributors/sindre-ai/maskin)](https://github.com/sindre-ai/maskin/graphs/contributors)
[![Star History](https://img.shields.io/github/stars/sindre-ai/maskin?style=social)](https://star-history.com/#sindre-ai/maskin&Date)

---

## Features

### Agents that actually run the process
<!-- docs/screenshots/agents.png -->
Agents read every insight, cluster signals into bets, break bets into tasks, and execute. You set direction and course-correct.

### Unified object model
<!-- docs/screenshots/graph.png -->
Insights, bets, and tasks are all **objects** connected by typed **relationships** (`informs`, `breaks_into`, `blocks`). One schema, one graph, infinite views.

### Live everything
<!-- docs/screenshots/live-events.png -->
Every mutation streams live over SSE. No refresh, no polling, no "last updated 2 hours ago." Agents and humans see the same event feed.

### MCP-native
<!-- docs/screenshots/mcp.png -->
39 MCP tools over stdio + HTTP. Point Claude Code, Claude Desktop, or any MCP client at Maskin and your agents have full workspace access.

### Triggers & automations
<!-- docs/screenshots/triggers.png -->
Cron- and event-based triggers spawn container sessions. "When an insight is tagged critical → clone it as a bet and ping me on Slack."

### Built-in integrations
<!-- docs/screenshots/integrations.png -->
OAuth flows for Slack, GitHub, Google, Linear, and more. Webhook handlers normalize inbound events into the same object graph.

## Quick start

```bash
# 1. Clone
git clone https://github.com/sindre-ai/maskin.git && cd maskin

# 2. Start the stack (Postgres, SeaweedFS, API, web UI)
docker compose up

# 3. Open the app
open http://localhost:3000

# 4. Wire Maskin into Claude Code using the banner command
#    (the dev server prints `claude mcp add maskin …` with a pre-provisioned API key)

# 5. Pick a template — say "development", "growth", or "custom" to the get_started tool
```

Prefer a local dev loop? `pnpm install && pnpm dev` runs the same stack outside Docker. See [CLAUDE.md](CLAUDE.md) for the full onboarding walkthrough.

## Example use cases

Pre-built templates configure a working workspace (object types, agents, triggers, seed objects) in one prompt:

- **[Development workspace](docs/templates/development.md)** — insight triage, bet evaluation, sprint board, status-change notifications. For product teams shipping software.
- **[Growth workspace](docs/templates/growth.md)** — competitor monitoring, content calendar, outreach pipeline, weekly digest. For launches and go-to-market.
- **[Sales workspace](docs/templates/sales.md)** — deal pipeline, contact enrichment, follow-up reminders, Slack deal-stage alerts. For founder-led sales.

Paste a template prompt into Claude Code (or any MCP client) after install — `get_started` applies it and hands back a running workspace in under two minutes.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Clients:  Web UI  •  Claude Code  •  Any MCP client     │
└────────┬──────────────────┬──────────────────┬───────────┘
         │ REST             │ MCP (stdio/HTTP) │ SSE
         ▼                  ▼                  ▼
┌──────────────────────────────────────────────────────────┐
│  apps/dev  (Hono + OpenAPIHono)                          │
│  routes  •  trigger-runner  •  session-manager           │
└────────┬──────────────────┬──────────────────┬───────────┘
         │                  │                  │
         ▼                  ▼                  ▼
    PostgreSQL         S3 (SeaweedFS)    Docker containers
    objects,           agent files       ephemeral agent
    events,            (skills,          sessions (Claude
    relationships      learnings,        Code, Codex,
    (PG NOTIFY)        memory)           custom CLIs)
```

TypeScript monorepo (pnpm + Turborepo). Backend on Hono.js + Drizzle + Postgres. Frontend on React 19 + TanStack Router + TanStack Query + Tailwind. Real-time via PG NOTIFY → SSE. Agents run in Docker sessions with persistent file storage in S3.

Deeper dive: [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Contributing

Contributions are welcome — issues, PRs, templates, integrations, and docs. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, conventions, and PR checklist.

Good first issues live in the [`good first issue`](https://github.com/sindre-ai/maskin/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label.

## License

Apache 2.0 — see [LICENSE](LICENSE).
