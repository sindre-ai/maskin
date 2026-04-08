# Why We Built a Product Development OS for AI Agents

**TL;DR:** We built [Maskin](https://github.com/sindre-ai/maskin) — an open-source workspace where AI agents run product development end-to-end. Insights in, shipped features out. It's not another AI framework. It's a self-improving product development loop.

---

## The Problem Nobody Talks About

Every product team has the same dirty secret: most of their time goes to *organizing* work, not *doing* it.

Customer feedback piles up in Slack channels. Meeting notes vanish into Google Docs. Support tickets accumulate in queues. The backlog grows faster than the team can groom it. And somewhere between the standup, the retro, and the roadmap review, the actual building gets squeezed into whatever hours remain.

We've all been there. You join a company to build products, and you spend half your week dragging cards across a Kanban board.

What if that entire layer of overhead — the triaging, the prioritizing, the status updates, the ticket writing — just... ran itself?

## The Insight That Started Everything

We noticed something while building with AI agents: **agents don't need project management tools designed for humans.** They don't need drag-and-drop boards. They don't need "swimlanes." They don't care about your carefully crafted Jira workflow.

What agents need is a simple, consistent data model and clear rules of engagement. Give them that, and they'll run circles around any human process.

So we stopped trying to bolt AI onto existing tools and asked a different question:

> What would product development look like if AI agents were the primary operators — and humans just steered?

The answer is Maskin.

## The Loop: Insights → Bets → Tasks

Maskin runs on one loop that compounds over time:

### 1. Insights

Raw signals flow in from everywhere — customer support, user research, Slack, competitor moves, internal observations. In a traditional setup, a human has to read all of this, figure out what matters, and summarize it for the team. In Maskin, an **Insight Analyzer** agent reads everything, clusters related signals, and surfaces what's important.

### 2. Bets

When the agent spots a pattern — say, 30 customers asking for the same feature — it proposes a **bet**. We call it a "bet" because every product decision is a gamble until users react to it. The bet includes a thesis, success criteria, and links to the supporting insights. A human reviews and approves (or redirects). The **Bet Planner** agent then breaks approved bets into concrete tasks.

### 3. Tasks

Tasks are where work happens. A **Senior Developer** agent picks up a task, reads the context (the bet, the supporting insights, any dependencies), creates a branch, writes code, opens a PR. A **Code Reviewer** agent reviews it. The task moves through statuses — `todo` → `in_progress` → `in_review` → `done` — all autonomously.

### 4. The Loop Closes

Here's where it gets interesting. A **Workspace Observer** agent watches everything that happened — what insights led to what bets, which tasks succeeded, which got blocked — and generates **meta-insights** about the system itself. "The team is spending too long on code review." "Bets related to onboarding have a 3x higher success rate." These meta-insights feed back into the loop as new signals.

The system literally improves itself.

```
Insights  →  Bets  →  Tasks  →  Feedback  →  Insights
   ↑                                            |
   └────────────── the loop closes ─────────────┘
```

## What Makes Maskin Different

**Agents are first-class citizens.** In Maskin, an AI agent and a human look identical to the system — same auth, same API, same permissions. Agents aren't plugins or integrations. They're the primary users. The UI exists for humans to observe and steer, not to do the grunt work.

**Everything is an API.** If you can see it in the UI, an agent can call it. There's no separate "agent interface" and "human interface." One unified surface, 39 MCP tools, fully programmable.

**The data model is dead simple.** Insights, bets, and tasks are all "objects" in a single table with a type discriminator. Relationships connect them. Events log every mutation. That's it. No complex schemas, no migration nightmares, no table-per-entity sprawl. Agents reason across the whole graph uniformly.

**It's self-improving.** Most tools are static — they do what you configure them to do. Maskin's observation loop means the system identifies its own bottlenecks and proposes fixes. Over time, the workspace gets better at product development *without human intervention*.

**It's open source.** Apache 2.0. Clone it, run it, modify it. No vendor lock-in. The architecture is intentionally simple — PostgreSQL, TypeScript, Hono.js — so you can understand and extend it in an afternoon.

## See It in Action

Run the demo seed and watch a fully populated workspace come to life:

```bash
git clone https://github.com/sindre-ai/maskin.git && cd maskin
pnpm install
pnpm db:seed
pnpm dev
```

The seed populates a Product Development workspace with:

- **5 AI agents** — Insight Analyzer, Bet Planner, Senior Developer, Code Reviewer, and Workspace Observer
- **Automated triggers** — agents fire on status changes and cron schedules
- **Sample data** — insights, bets, and tasks in various stages of the pipeline, with relationships connecting them all
- **Meta-insights** — the Workspace Observer analyzing its own system, showing the self-improving loop in action

You'll see the full Insight → Bet → Task → Meta-insight cycle playing out — signals being analyzed, bets being proposed, tasks being broken down and executed, and the system observing itself.

## The Tech (for the Curious)

Maskin is deliberately boring technology, assembled thoughtfully:

- **TypeScript monorepo** (Turborepo + pnpm workspaces) — one language, top to bottom
- **Hono.js API** with auto-generated OpenAPI specs from Zod schemas
- **PostgreSQL** for everything — data, events (append-only log), real-time (PG NOTIFY → SSE). No Redis, no Kafka, no message queue
- **Drizzle ORM** — type-safe SQL with zero overhead
- **Docker containers** for ephemeral agent execution — spin up, run, tear down
- **S3-compatible storage** for agent files (skills, learnings, memory)
- **MCP server** (39 tools) — any MCP-compatible client can connect and operate the workspace

The architecture is a modular monorepo where each package is independently importable. The whole thing starts with `pnpm dev`.

## Why Open Source, Why Now

AI agents are about to change how every team works. The tools we use for product development — Linear, Jira, Asana — were designed for humans clicking buttons. They'll adapt, sure. But they're starting from the wrong foundation.

We believe the next generation of work tools needs to be **agent-native from day one**. Not "AI-assisted." Not "copilot-enabled." Native. And that foundation should be open, so everyone can build on it.

Maskin is our bet on that future. It's the first product in what we plan to be a full suite of agent-native business tools — CRM, meeting notes, and more — all open source, all composable.

## Try It

```bash
git clone https://github.com/sindre-ai/maskin.git
cd maskin && pnpm install && pnpm db:seed && pnpm dev
```

Star the repo if you believe product development should run itself: [github.com/sindre-ai/maskin](https://github.com/sindre-ai/maskin)

We'd love your feedback. Open an issue, start a discussion, or just poke around the code. It's all there.

---

*Built by [Sindre AI](https://github.com/sindre-ai). Licensed under Apache 2.0.*
