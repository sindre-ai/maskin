---
title: Loops
slug: loops
description: The loop primitive — persistent multi-agent processes with triggers as steps, objects flowing through in_loop edges, and a feedback step that closes the loop.
last_updated: 2026-08-11
---

# Loops

A **loop** is a persistent multi-agent process: a goal wrapped around triggers, agents, and
objects changing state. Almost everything can be modeled as a loop — when an object reaches its
end state, the learning should feed back into improving the loop or seed the next object through
the same loop.

## Data model

A loop is not a separate table. It is composed from existing primitives:

| Piece | Where it lives |
|-------|----------------|
| The loop itself | `objects` row with `type = 'loop'` (statuses: `running`, `waiting`, `paused`, `archived`) |
| Steps | Ordinary `triggers` rows, referenced by the loop's `metadata.trigger_ids` |
| Agents | The `target_actor_id` of each step trigger (must be an agent actor) |
| Member objects | `in_loop` relationship edges — source = loop, target = member object (any type) |
| Entry / close conditions | `metadata.entry_condition`, `metadata.close_condition` (plain language) |
| Human decision points | `metadata.human_decision_points` (count) |
| Per-loop terminal statuses | `metadata.closed_statuses` — `{ "<type>": ["status", ...] }` |

Member objects can be **any workspace-defined type**, including custom types added via
extensions. Loop membership is the edge, never a back-reference on the member.

## Open vs closed loops

Open vs closed is **structural**, not a stored flag:

- **Open loop** — no feedback mechanism yet. Still a loop; steps fire, objects flow.
- **Closed loop** — one of its steps is a **feedback step**: an event trigger that fires when a
  member object reaches its end state (the close condition), whose agent captures learnings
  (e.g. creates an insight/knowledge object linked with `informs`), improves the loop, and/or
  seeds the next object into it.

Prefer closing every loop.

## Humans (and agents) on the loop

"Human on the loop" is not a special field — it is a step like any other: a trigger whose agent
notifies or @mentions the human at decision points (`create_comment` with `mentions`, or
`create_notification`). Another agent can be on the loop the same way. Triggers must target
agent actors, so human participation always flows through an agent step.

## Derived read API

`GET /api/loops` (`apps/dev/src/routes/loops.ts`) returns every loop in the workspace with
derived stats: a composite `pill` (`running` / `waiting_on_you` / `paused` / `archived`),
in-progress and closed member counts, median time-to-close, the step trigger ids, and the
distinct agent ids those triggers fire.

Whether a member counts as **closed** is resolved per loop: the loop's own
`metadata.closed_statuses` entry for the member's type wins; otherwise the built-in fallback
table in `loops.ts` applies (bet/task/insight/commitment). Custom object types have no fallback —
a loop flowing custom types **must** set `closed_statuses` or its closed counts stay at zero.

## MCP tools

The MCP server exposes loops as first-class tools (`packages/mcp`):

- **`create_loop`** — one call creates the whole loop: the loop object, inline `steps` (each
  becomes a trigger — `when: { cron }` or `when: { object_type?, action, filter? }`), attached
  pre-existing `trigger_ids`, `in_loop` edges for `object_ids`, and `closed_statuses`. All ids,
  types, and statuses are validated against the workspace before anything is created; if the
  loop insert fails, just-created step triggers are rolled back.
- **`update_loop`** — rename/status/conditions, `add_steps`, `add_trigger_ids` /
  `remove_trigger_ids` (safe read-modify-write of `metadata.trigger_ids`), `add_object_ids` /
  `remove_object_ids` (membership edges), `closed_statuses`.
- **`list_loops`** — wraps `GET /api/loops` with deep links to `/{workspace}/loops/{id}`.

Do not author loops through raw `create_objects` — the tools above wire the metadata and edges
correctly. Marketplace loop *templates* are installed via `get_started` (see
`apps/dev/src/routes/installed-loops.ts`); installing one provisions its items and creates the
`type = 'loop'` object automatically.

## Event steps and dynamic types

Loop steps are event triggers matched by `apps/dev/src/services/trigger-runner.ts`. The runner
hydrates the current object row from the `objects` table for `updated` / `status_changed`
events **regardless of the object's type** (it probes by entity id — any UUID — and treats a
missing row as "not an object"), so filters like `{ "status": "qualified" }` work for custom
workspace-defined types exactly like built-ins. Do not reintroduce entity-type allow-lists
there.
