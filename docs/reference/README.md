---
title: Maskin primitives reference
slug: reference
description: Agent-facing index of canonical documentation for Maskin's own primitives — bets, tasks, objects, insights, sessions, relationships, MCP tools, notifications, and the workspace schema.
last_updated: 2026-07-09
---

# Maskin primitives reference

When touching a Maskin primitive, read the matching page under `docs/reference/` before trusting model memory.

This directory holds one canonical page per Maskin primitive. Each page follows the same shape so both a human developer and a coding agent can look up accurate, version-correct answers without inventing signatures.

## Primitive pages

- [objects.md](./objects.md) — the base object model shared by every Maskin entity: create, get, update, delete, and metadata semantics.
- [bets.md](./bets.md) — the bet primitive: shaped, time-boxed outcomes; lifecycle statuses (`signal → define → active → refine → done`); success, acceptance criteria, and exit criteria.
- [tasks.md](./tasks.md) — the task primitive: units of work under a bet, driver assignment, statuses (`todo → in_progress → in_review → done`), and handoff conventions.
- [insights.md](./insights.md) — the insight primitive: durable learnings that inform future bets, tag taxonomy, and `informs` edges.
- [sessions.md](./sessions.md) — the session primitive: agent runs, lifecycle, resume paths, and how sessions connect to the object they act on.
- [relationships.md](./relationships.md) — the relationship primitive: edge types (`breaks_into`, `blocks`, `relates_to`, `informs`, `duplicates`) and how to list and create them.
- [loops.md](./loops.md) — the loop primitive: persistent multi-agent processes; triggers as steps, `in_loop` membership edges, open vs closed loops, per-loop `closed_statuses`, and the create_loop/update_loop/list_loops MCP tools.
- [mcp-tools.md](./mcp-tools.md) — the MCP tool surface: which tools exist, what they return, and when to reach for each.
- [notifications.md](./notifications.md) — the notification primitive: `needs_input` vs. informational, @mention semantics, and how sessions get spawned from mentions.
- [workspace-schema.md](./workspace-schema.md) — the workspace schema primitive: how to discover valid object types, statuses, metadata fields, and enum values before writing.

## Frontmatter shape

Every page in this directory uses the same YAML frontmatter:

```yaml
---
title: <human-readable page title>
slug: <url-safe slug matching the filename>
description: <one-sentence summary — used by index tooling and future public-docs export>
last_updated: <YYYY-MM-DD>
---
```

This shape is fixed so the parked public-docs bet ([AI-first docs](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/d357d521-ee8b-4b2e-a4ef-6aabe97ff77c)) can consume the same source unchanged.
