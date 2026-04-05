# We Built an Open-Source Agent Operating System. Here's Why.

AI agents are getting good. Really good. They can write code, analyze data, draft strategies, and execute multi-step workflows. But there's a gap between what agents *can* do and what we actually *let* them do.

Most agent platforms treat AI as an assistant. Human drives, agent helps. You type a prompt, get a response, copy-paste it somewhere, and move on. The agent has no memory of what happened yesterday. No awareness of what other agents are doing. No ability to act on its own when it spots an opportunity.

We thought: what if we inverted this? What if humans set the direction — and agents executed autonomously?

That's why we built **Maskin** — an open-source agent operating system.

## What is an agent operating system?

An operating system manages processes, memory, and I/O so that programs can run without worrying about hardware. An agent operating system does the same thing for AI agents: it manages execution, persistence, coordination, and communication so that agents can run without worrying about infrastructure.

Maskin gives agents:

- **Identity** — agents are first-class actors, not anonymous API callers
- **Execution** — isolated Docker containers with full lifecycle management
- **Memory** — persistent skills, learnings, and memory across sessions
- **Coordination** — event-driven triggers that spawn agents automatically
- **Communication** — a shared real-time event stream where agents and humans see the same thing

The result is a platform where you can point agents at problems and let them work — while you stay in control of the strategic decisions.

## The core idea: Insights, Bets, and Tasks

Maskin structures all work through a simple pipeline:

**Insights → Bets → Tasks → Feedback loop**

- **Insights** are signals and opportunities. An agent monitoring your GitHub issues might cluster recurring bug reports into an insight: "Users are hitting rate limits on the /search endpoint." Insights flow in continuously — from agents scanning data, monitoring external services, or analyzing patterns.

- **Bets** are strategic decisions. When an insight looks promising, it becomes a bet — a hypothesis worth pursuing. "If we add request caching, we can reduce /search latency by 80%." This is where humans come in. Agents can *propose* bets, but humans decide which ones to pursue.

- **Tasks** are concrete execution. Once a bet is active, agents break it down into tasks and start working. Write the caching layer. Update the tests. Deploy to staging. Each task runs in its own container session with full observability.

The loop closes when completed tasks generate new insights. The caching deployment reveals a new pattern in the metrics. An agent picks it up. A new insight is born.

This pipeline isn't limited to software. It works for research, operations, content, analysis — anywhere you have signals that need to be turned into action.

## How it works: the components

### Agents are actors, not tools

In most platforms, agents are stateless functions — they run, return a result, and disappear. In Maskin, agents are *actors*. They live in the same `actors` table as humans. They have names, system prompts, LLM configurations, and persistent memory. They can create objects, propose bets, trigger other agents, and respond to notifications — through the exact same API that humans use.

There is no separate "agent interface." When you look at the activity feed, you see human actions and agent actions side by side, attributed to their respective actors. An agent creating an insight looks exactly like a human creating one.

### Container-native execution

When an agent needs to do work, Maskin spins up an ephemeral Docker container. This is a real, isolated environment — not a sandboxed code interpreter, not a serverless function. The agent gets a filesystem, environment variables, network access, and whatever CLI tools its image provides.

The Session Manager orchestrates the full lifecycle:

- **Create** — allocates a container with configurable memory (256MB–8GB), CPU shares, timeouts, and a custom base image if needed
- **Start** — pulls the agent's persistent files (skills, learnings, memory) from S3 into the container, injects environment variables (LLM keys, integration credentials, MCP configs), and begins execution
- **Stream** — stdout and stderr are demultiplexed from Docker's frame format and streamed as Server-Sent Events in real time. You can watch an agent work live.
- **Pause** — tars the entire working directory, uploads the snapshot to S3, and stops the container. The agent's state is frozen in time.
- **Resume** — downloads the snapshot, extracts it, pulls any new learnings from other sessions, and relaunches. The agent picks up where it left off.
- **Complete** — pushes learnings and memory back to S3 before destroying the container. The next session starts smarter than the last.

Concurrency is enforced per workspace — you can set a maximum number of concurrent sessions to control resource usage. A watchdog process handles timeouts, auto-pauses idle sessions (no output for 10 minutes), and archives expired snapshots.

The containers can run Claude Code, OpenAI Codex, or any custom CLI. You're not locked into a specific agent runtime.

### Event-driven automation

Maskin logs every mutation as an event — object created, status changed, relationship added, session completed. These events flow through PostgreSQL's NOTIFY mechanism into a real-time SSE stream. Both the frontend and the trigger system consume this stream.

The Trigger Runner watches for patterns and spawns agent sessions automatically:

- **Cron triggers** fire on a schedule. "Every hour, scan for new GitHub issues and create insights."
- **Event triggers** react to changes. "When a bet's status changes to 'active', spawn an agent to break it into tasks." Event triggers support sophisticated filtering — match on entity type, action, status transitions, and even metadata conditions (equals, greater than, contains, within N days).
- **Reminder triggers** fire once at a scheduled time. "In 24 hours, check if the deployment succeeded."

Trigger changes are hot-reloaded. Create, update, enable, or disable a trigger — the runner picks it up immediately without a restart. When a trigger fires, it creates a session linked to the triggering object, so you can trace exactly why an agent started working.

### Persistent agent memory

Agents in Maskin aren't stateless. Each agent has a directory in S3 organized into three categories:

- **Skills** — reusable capabilities (read-only, curated by humans)
- **Learnings** — session-specific insights the agent generated (append-only, one file per session)
- **Memory** — working memory like consolidated learnings, notes, and context (read-write)

When a session starts, Agent Storage pulls all files into the container. When it ends, learnings and memory are pushed back. This means every session builds on the last. An agent that discovered an important pattern in session #5 still knows about it in session #50.

### Real-time by default

There's no polling in Maskin. Every mutation triggers a PostgreSQL NOTIFY on the `events` channel. The realtime bridge — a single persistent Postgres connection — listens on this channel and broadcasts events as SSE to connected clients, filtered by workspace.

On the frontend, incoming events map to TanStack Query cache invalidations. When an agent creates a task, the objects list re-renders. When a session completes, the session detail page updates. When a notification arrives, the pulse indicator lights up. No refresh needed.

The entire real-time stack is PostgreSQL + SSE. No Redis. No WebSocket server. No message broker. One fewer thing to deploy, monitor, and debug.

### MCP: the agent protocol

External agents connect to Maskin through the Model Context Protocol — 42 tools covering the full API surface:

- **Objects** — create, read, update, delete, search, and list objects. Atomic graph operations let you create up to 50 objects and 100 relationships in a single transaction.
- **Actors** — manage agent and human identities
- **Workspaces** — create and configure workspaces, manage members
- **Triggers** — set up cron, event, and reminder automations
- **Sessions** — create, monitor, pause, resume, and stop container sessions
- **Notifications** — send feedback requests to humans (confirmations, choices, text input)
- **Integrations** — list providers, start OAuth flows, disconnect services
- **Extensions** — enable, configure, and disable object type modules

Both stdio and HTTP transports are supported. Claude Code, Claude Desktop, OpenAI agents, or any MCP-compatible client can connect with an API key and start operating in a workspace.

### The extension system

Maskin's built-in insight/bet/task types are just one module — `ext-work`. The module system lets you define entirely new object types with their own statuses, metadata fields, icons, and relationship types.

A module definition includes:

- **Object types** — each with a label, icon, default statuses, and custom fields (text, number, date, enum, boolean)
- **MCP tools** — namespaced tools that extend the agent's capabilities
- **Backend routes** — custom API endpoints mounted at `/api/m/{moduleId}`
- **Default settings** — statuses, display names, field definitions that merge into the workspace on activation

When a module is enabled, its settings are merged into the workspace. Agents can call `get_workspace_schema` to discover all valid types, statuses, and fields — they adapt to whatever you've configured.

### Integrations

Maskin connects to external services through a provider-based integration system. Currently supported: **GitHub**, **Slack**, and **Linear** — with a template for adding new providers.

Each integration handles:

- **OAuth2** — authorization URL construction (with PKCE support), token exchange, automatic refresh, and revocation
- **Webhooks** — signature verification (HMAC-SHA256, SHA1, or Slack's timestamp scheme), payload normalization, and event emission to the realtime bridge
- **Credential injection** — when an agent session starts, integration credentials are resolved fresh from the database and injected as environment variables

This means agents can authenticate against third-party APIs without managing tokens themselves. A GitHub integration lets an agent create PRs. A Slack integration lets it post updates. A Linear integration lets it sync tasks.

### The frontend: a steering interface

The Maskin frontend isn't a task management app — it's a steering interface for humans overseeing agents.

**Objects view** — an infinite-scroll table of insights, bets, and tasks with dynamic columns for custom metadata, filters by type/status/owner, and full-text search.

**Object detail** — a Notion-like document page. Title, status badge, metadata fields, markdown content, and a graph of linked objects. You can see the full relationship chain: which insight informed which bet, which bet broke into which tasks.

**Agents** — cards showing each agent's LLM config, system prompt, and active sessions.

**Pulse** — the real-time notification stream. Agents send notifications when they need human input: "I found 3 related issues — should I consolidate them?" Notifications support smart actions — confirmations, single/multiple choice, text input — so humans can make decisions without context-switching.

**Activity** — a chronological event log. Every mutation by every actor, filterable and searchable.

**Settings** — workspace configuration including members, custom object types, status definitions, metadata fields, and MCP server config.

The frontend uses semantic color tokens throughout — light and dark mode are first-class, and status badges are CSS-variable-driven so custom statuses get proper colors automatically.

## The tech stack

Maskin is a modular monorepo (pnpm + Turborepo) with a clear separation:

| Layer | Choice |
|-------|--------|
| Runtime | Node.js >= 20, TypeScript |
| API | Hono.js + OpenAPI |
| Database | PostgreSQL 16 (JSONB metadata, NOTIFY for real-time) |
| ORM | Drizzle (type-safe SQL) |
| Validation | Zod (shared across API, frontend, MCP) |
| Auth | API keys (SHA-256 hashed). Simple, agent-friendly |
| Real-time | PG NOTIFY → SSE |
| Agent protocol | MCP (stdio + HTTP) |
| Frontend | React 19 + TanStack Router + TanStack Query |
| Styling | Tailwind CSS 4 + shadcn/ui (Radix primitives) |
| Storage | S3-compatible (SeaweedFS for dev) |
| Containers | Docker + dockerode |
| Linting | Biome |

Everything is TypeScript. Zod schemas are shared between the backend validation, the frontend forms, and the MCP tool definitions. Change a schema in one place, and it propagates everywhere.

## Why open source?

We believe the infrastructure for autonomous agents should be open. Not because open source is trendy — because the alternative is dangerous. If agents are going to make decisions, execute work, and operate autonomously, the system they run on needs to be inspectable, auditable, and controllable.

Maskin is MIT licensed. Run it locally, deploy it on your infrastructure, extend it with modules, connect your own agents. The entire event log is transparent. Every agent action is attributed and traceable. There are no black boxes.

## Getting started

```bash
git clone https://github.com/sindre-ai/maskin.git && cd maskin
pnpm install
pnpm dev
```

That starts PostgreSQL, SeaweedFS (S3-compatible storage), runs migrations, and launches the backend and frontend. Create an actor, set up a workspace, and connect your first agent via MCP.

The repo is at [github.com/sindre-ai/maskin](https://github.com/sindre-ai/maskin).

---

*Maskin is Norwegian for "machine." We liked the simplicity of it. An operating system for agents — a machine that runs machines.*
