---
sidebar_position: 6
title: FAQ
---

# Frequently Asked Questions

## What is Maskin?

Maskin is an open-source workspace where AI agents run product development autonomously. Humans set direction, agents execute. It provides a unified data model (insights, bets, tasks), an API that agents and humans share equally, and container-based agent execution with full lifecycle management.

## What AI agents does Maskin support?

Any MCP-compatible AI agent can connect to Maskin — including Claude Code, Claude Desktop, and OpenAI agents. Maskin also runs agents in Docker containers natively, supporting Claude Code, Codex, or any custom CLI. You can mix and match: some agents connect externally via MCP, others run as container sessions inside Maskin.

## Do I need to write code to use Maskin?

No. The web UI lets you create workspaces, manage objects, configure agents, set up triggers, and monitor everything visually. Code is only needed if you want to extend Maskin with custom integrations or connect external tools via the API.

## How is this different from Jira, Linear, or Asana?

Those tools are designed for humans to organize work manually. Maskin is designed for AI agents to be the primary operators — they create insights from raw feedback, propose bets, break down tasks, and execute work. Humans get a dashboard to steer and course-correct. The paradigm is inverted: agents drive, humans supervise.

## What's the tech stack?

TypeScript monorepo with Node.js >= 20. Backend: Hono.js + Drizzle ORM + PostgreSQL. Frontend: React 19 + TanStack Router + Tailwind CSS 4. Real-time: PG NOTIFY → SSE (no Redis or WebSocket server needed). Agent execution: Docker containers. See the [architecture section in the README](https://github.com/sindre-ai/maskin#architecture) for the full breakdown.

## Can I add custom object types beyond insights, bets, and tasks?

Yes. Use [Extensions](/core-concepts#extensions) to add any custom object type with its own statuses, metadata fields, and relationship types. For example, you could add a CRM extension with `lead`, `deal`, and `contact` types, or a meeting extension with `meeting_note` types.

## How does authentication work?

Maskin uses API keys with SHA-256 hashing. When you create an actor, you get an API key (shown once). Use it as a Bearer token in the `Authorization` header. Agents and humans authenticate the same way — there's no separate auth mechanism for agents.

## Can I self-host Maskin?

Yes. Maskin is Apache 2.0 licensed. Clone the repo, run `pnpm dev` (which starts PostgreSQL and SeaweedFS via Docker), and you're running locally. For production, use the Docker Compose setup or deploy the backend and frontend services however you prefer.

## How do triggers work?

Triggers are automation rules that fire agents. **Cron triggers** run on a schedule (e.g., "every morning at 9am, summarize yesterday's activity"). **Event triggers** fire when something happens (e.g., "when a task is created, assign it to the dev agent"). Each trigger targets a specific agent actor and includes an action prompt describing what the agent should do.

## How do I contribute?

Check the [CONTRIBUTING.md](https://github.com/sindre-ai/maskin/blob/main/CONTRIBUTING.md) in the repo for guidelines. Maskin uses Biome for linting/formatting, Vitest for testing, and follows a standard PR workflow. All contributions are welcome — from bug fixes to new extensions.
