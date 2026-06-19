# Starter Prompts

Copy-paste prompts that bootstrap a **fully configured Maskin workspace** — object types, statuses, relationships, agents, triggers, and seed data — in a single shot.

Each prompt runs through any MCP-connected client (Claude Code, Claude Desktop, Cowork, Claude Web) and calls the `get_started` Maskin MCP tool. End-to-end time: under two minutes.

## Which one?

| Prompt | Best for | Ships with |
|---|---|---|
| [Product Development](./product-development.md) | Product teams building and shipping software | Insight Triager, Bet Evaluator, Task Executor — all wired to GitHub |
| [Growth](./growth.md) | Founders running a launch/outreach pipeline | SDR, Content Agent, Scout, Growth Ops, Launch Manager + CRM + LinkedIn module |
| [Sales](./sales.md) | Outbound sales teams managing deals end-to-end | Lead Researcher, Outreach Drafter, Pipeline Analyst, Deal Coach + CRM + pipeline |

## How to use

1. Connect the [Maskin MCP server](../README.md#-zero-click-setup-from-claude-code) to your client of choice.
2. Open the prompt page above and copy the fenced block into a chat.
3. Let the agent run `get_started` — it will preview the template, apply it, and print the workspace URL.
4. Customise from there: edit agent system prompts, add real objects, wire additional triggers.

## Not a lock-in

Each starter prompt is a **starting point**, not a template you're stuck with. After setup you can rename agents, change statuses, add custom fields, disable triggers, or delete seed data. The prompt wires up enough that the workspace is useful in its first minute — you own it from there.

## Want something different?

Paste any of the three prompts and change the instructions at the end ("add a contact called X", "rename the Task Executor to Shipping Agent", "drop the LinkedIn module"). The agent will adapt. If none of the three match your team, ask `get_started` for the `custom` template — it walks you through a short questionnaire and tailors the workspace from your answers.
