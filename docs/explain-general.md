# Maskin — What Is It?

**One-liner:** An open-source workspace where AI agents run your product development — and humans just steer.

## The Problem

Product teams drown in feedback. Customer messages, internal ideas, meeting notes, support tickets — it's endless noise. Humans spend more time organizing work than doing it. Kanban boards, backlog grooming, status updates — it's all overhead.

## The Idea

What if AI agents handled all of that? Not just helping — actually *running* the process:

1. **Insights** — Raw feedback flows in from anywhere (support tools, Slack, meetings, etc.). Agents read it all — humans can't keep up, agents can.

2. **Bets** — Agents find the signal in the noise. They cluster related feedback, spot patterns, and propose "bets" — experiments the team should try. It's called a "bet" because every product decision is a gamble until users react to it.

3. **Tasks** — Agents break bets into concrete work items and execute them. No human needed to drag cards across a board.

## What Makes It Different

- **Agents are first-class citizens.** An AI agent and a human look identical to the system — same login, same API, same permissions. Agents aren't plugins or add-ons; they're the primary users.
- **Everything is an API.** If you can see it in the UI, an agent can call it. If an agent can do it, a human can too. No special interfaces.
- **Humans steer, not drive.** Agents run autonomously and inform humans what they did. Humans course-correct when needed — like a self-driving car where you can grab the wheel.
- **It's open source.** Anyone can run it themselves. The business model is hosting it for companies (managed, secure, EU-compliant).

## The Bigger Picture

This dev workspace is just the first product. The plan is to build a whole suite — CRM, meeting notes, etc. — all open source, all agent-native, all composable into one platform. Each runs standalone or together.

## Tech-wise

Intentionally simple. One database (PostgreSQL), one language (TypeScript), real-time updates baked in. An MCP server lets external AI agents (like Claude Code) plug in natively.
