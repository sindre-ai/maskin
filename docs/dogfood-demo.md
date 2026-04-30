# 60-second standup demo runbook

Repeatable validation for the **Rich MCP app experience** bet
(`158422d7-01e3-4148-bd62-8cebdaf7e9d4`, Task 4/3
`fbffdd5b-a335-40d6-9ab2-e0563b13d7f4`). Anyone with a Maskin workspace +
Claude.ai (or Claude Desktop) MCP connection can run it. The goal is to
exercise the full triage → bet → tasks → assign loop **without ever leaving
Claude**, and capture the four bet-level success metrics.

## Prerequisites

- Local dev stack running (`pnpm dev`) or a deployed environment with the
  current `bet/mcp-rich-app` build.
- Maskin MCP server registered in your Claude client. If you cloned this
  repo, follow the onboarding flow in [`CLAUDE.md`](../CLAUDE.md) to grab
  the auto-generated `claude mcp add maskin …` line from the dev banner.
- A workspace with at least one `insight` of status `new` and known
  workspace ID. Seed via `pnpm db:seed` or use an existing dev workspace.
- Stopwatch (phone is fine) for the time-to-complete metric.

## Demo script (perform inside Claude — keep the web app tab closed)

1. **Pull latest insights.** Ask Claude to "list all new insights in
   workspace `<id>`". The response should render as `ObjectListTable`
   with status badges and a deep link per row.
2. **Triage one insight.** Ask Claude to open one of those insights, then
   "mark this insight as approved". The card should mutate inline (no
   page reload, no web app bounce) and the status badge should flip.
3. **Create a bet from the insight.** Ask Claude to "create a bet from
   this insight titled '…' with content '…'". The reply should be an
   `ObjectCard` (or document view) with an "Open in Maskin" link.
4. **Break the bet into 3 tasks.** Ask Claude to "break this bet into
   three tasks: A, B, C". The reply should render as `ObjectKanban` (or
   `ObjectListTable` if statuses don't repeat) with rows for each task.
5. **Assign owners to the tasks.** Ask Claude to "assign me as owner of
   task A, and `<another actor uuid>` to tasks B and C". Each card
   should mutate inline and show the new owner.
6. **Open one deep link.** Click the "Open in Maskin" link on any card.
   The web app should land on the matching object detail view.

If any step required you to think "I should switch to the web app for
this" — that's a metric (qualitative item #3, target zero).

## What gets captured (bet-level success metrics)

| Metric                                                          | Target            | How to capture                                       |
| --------------------------------------------------------------- | ----------------- | ---------------------------------------------------- |
| % MCP tool calls that rendered a rich card                       | ≥ 50%             | Count rich-render vs. plain-text fallback in chat.   |
| At least one in-chat mutation                                    | yes               | Step 2 or step 5 must succeed without web-app bounce. |
| Qualitative "I need the web app for this" moments                | 0                 | Tally during the run; file each as a follow-up task. |
| Time-to-complete the happy path                                  | ≤ 60 s            | Stopwatch from step 1 prompt to step 6 click.         |

After the run, append your numbers + notes to the **workspace document**
linked from the bet via `relates_to` (the canonical metric capture; this
runbook is the script, the doc is the ledger). The Definition of Done
also requires **3+ pieces of qualitative feedback** from teammates running
the same demo — log each in the workspace doc with a name and date.

## Static validation (what the bet branch already supports)

| Demo step                          | Code path on `bet/mcp-rich-app`                                                              | Status |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| 1. List insights                   | `apps/web/src/mcp-apps/objects/app.tsx` → `ObjectListView`; widget catalog falls through to `ObjectListTable` for heterogeneous lists. | shipped |
| 2. Triage / status mutate          | `ObjectDocument` → `handleUpdateStatus` → `callTool('update_objects', { updates: [{ id, status }] })`. | shipped (F8 #353) |
| 3. Create bet (rich card)          | `create_objects` server response carries `_meta.toolName` + `_meta.workspaceId` + `_meta.webAppBaseUrl`; objects app renders `ObjectDocument` with `WebAppLink target={ kind: 'object' }`. | shipped (3/3 #315 + F2 #325) |
| 4. Break into 3 tasks              | `create_objects` (graph variant) → `RelationshipGraph` if edges present, else falls back to `ObjectListTable` / `ObjectKanban` per `RENDERING.md`. | shipped (F3 #352) |
| 5. Assign owners                   | `ObjectDocument` → `handleUpdateOwner` → `callTool('update_objects', { updates: [{ id, owner }] })`. Server-side `updateObjectSchema` already accepts `owner: uuid|null`. | shipped (F8 #353; F4 #354 generalises to all widgets) |
| 6. Deep link                       | `WebAppLink` consumes `_meta.webAppBaseUrl` + `_meta.workspaceId`; `buildWebAppPath` covers every `WebAppTarget` kind. | shipped (F2 #325) |

The 8 MCP app bundles (`objects`, `relationships`, `actors`, `workspaces`,
`events`, `triggers`, `graph`, `notifications`) are all built by
`pnpm --filter @maskin/web build:mcp` on this branch.

## Known gaps to watch for during the run

- **Object delete** is a one-click affordance only inside the F4 confirm
  dialog (PR #354). On the bet branch HEAD without #354 merged, delete
  on cards goes through `delete_object` directly — verify this isn't a
  surprise destructive action during the demo.
- **Kanban DnD** is intentionally out of scope (planned in F7) — status
  changes go through prompt + inline edit, not drag.
- **Graph canvas layout** is also F7 — the current `RelationshipGraph`
  is the list-of-edges fallback documented in `RENDERING.md`.
- **`FRONTEND_URL` in compose** — production deploys must list
  `FRONTEND_URL` in `docker-compose.prod.yml` env or deep links resolve
  to `http://localhost:5173` (tracked under follow-up task
  `611c6d04-e7a1-4019-86db-94aad6796bde`).

## After the demo

1. Update the workspace document linked from the bet via `relates_to`
   with the four numbers + qualitative notes.
2. File any "I need the web app for this" gaps as new tasks under the
   bet (`breaks_into`).
3. Once 3+ teammates have run the demo and logged feedback, the bet's
   Definition of Done is satisfied.
