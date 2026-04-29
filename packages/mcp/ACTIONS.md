# MCP card action layer

This document is the contract between MCP cards (`apps/web/src/mcp-apps/`) and
the underlying mutation surface (`packages/mcp/src/tools.ts` →
`apps/dev/src/routes/`). It complements
[`RENDERING.md`](./RENDERING.md): rendering decides _what shape a card takes_,
this file decides _what actions a card may surface_ and how.

The goal is the bet's success criterion #3 — _core actions doable directly from
chat_ — without re-implementing auth, audit, or confirmation patterns per card.

## v1 scope

The
[v1 decision doc](https://github.com/sindre-ai/maskin/issues/) (workspace
insight `35783ec4-b85e-4ead-98c6-2f1e40b95542`) limits the in-card mutation
surface to operations that are **reversible or low-blast-radius**:

| Mutation                  | Tool                | Surfaces in card                                | Confirmation |
| ------------------------- | ------------------- | ----------------------------------------------- | ------------ |
| Update status             | `update_objects`    | `<StatusAction>` on object widgets              | One-click    |
| Update owner              | `update_objects`    | `<OwnerAction>` on object widgets               | One-click    |
| Add relationship          | `update_objects`    | _exposed via the widget catalog from F7+_       | One-click    |
| Mark done (status=done)   | `update_objects`    | `<StatusAction>` shortcut on tasks              | One-click    |
| Soft-delete (object)      | `delete_object`     | `<ActionButton mode="destructive">` on cards    | **Confirm**  |

Out of scope for v1 (planned: v2):

- Hard delete via one-click — always routed through a confirmation dialog,
  never a bare button.
- Bulk operations — multi-select on lists/kanban.
- Schema mutations from cards (workspace fields, statuses) — those land in F9.
- Server-identity-based mutations (e.g. agent-driven cards) — v1 actions are
  always the calling end-user.

## Auth model — calling-user, not server identity

MCP tool invocations from a card flow over the existing
`useCallTool()` channel (`apps/web/src/mcp-apps/shared/mcp-app-provider.tsx`).
That channel posts the call back to the MCP host, which forwards it to the
Maskin MCP server with whichever credentials the host was registered with —
which is the end-user's `ank_…` key from `claude mcp add`.

The MCP server treats every `apiCall` as a Bearer-token request against
`/api/*` (`packages/mcp/src/server.ts:108`). The
[auth middleware](../auth/src/middleware.ts) extracts `actorId` from that
token, enforces workspace membership via the `X-Workspace-Id` header, and
fails closed (`401`/`404`) when the token is missing, invalid, or scoped to a
different workspace. From the perspective of `/api/objects/:id`, an action
fired from a card is indistinguishable from one fired from the web app — same
actor, same row-level permissions, same workspace scope.

Consequences for cards:

- A card never embeds, requests, or stores a Bearer token. It hands the
  arguments to `callTool`; the host owns the auth.
- `<ActionButton>` and `useObjectMutation` surface `401`/`403`/`404` errors
  back to the user as inline error text — no silent retry, no redirect.
- Cross-workspace mutations are not possible from a card: the `_meta.workspaceId`
  passed back to the card is the only workspace it can target without a
  separate `list_workspaces` round-trip.

## Mutation surface

All v1 mutations route through the existing `update_objects` and
`delete_object` MCP tools. We deliberately did not add a new
`mcp/actions` HTTP endpoint:

- `update_objects` already accepts `status`, `metadata`, and (extended in this
  task) `owner` and edge creates — every v1 mutation maps to one call.
- The existing tool dispatch already enforces auth + workspace scope and
  writes to the `events` audit table on the backing `PATCH /api/objects/:id`
  route. A second endpoint would either duplicate that path or weaken it.

`update_objects` was extended in this task to accept `owner` on the per-object
update record so cards can change ownership without bouncing to the web app.
The validation lives in `updateObjectSchema` in
`packages/shared/src/schemas/objects.ts`; `owner: z.string().uuid().nullable().optional()`
matches the column shape and lets cards pass `null` to clear the field.

## Confirmation UX

Confirmation policy lives in `apps/web/src/mcp-apps/shared/actions/policy.ts`
as a single declarative table (`MUTATION_POLICY`). The two states are:

- **One-click** — fired immediately when the user clicks. Reverts via the
  same affordance (e.g. flipping `status` back, re-assigning owner).
- **Confirm** — opens `<ConfirmDialog>` with the mutation summary, the actor
  the change will run as, and a destructive-styled confirm button. Cancel
  short-circuits the call entirely.

Cards do not invent their own confirmation — `<ActionButton>` reads the policy
table and renders the dialog when needed. Wave 2/3 cards (F7/F8) inherit the
same surface.

## Optimistic update + reconciliation

`useObjectMutation` exposes `(optimisticValue, run, isPending, error)`:

1. On `run`, the hook stores the optimistic value locally and dispatches the
   `callTool('update_objects', …)` call.
2. The widget renders `optimisticValue ?? object.field` so the change appears
   instantly.
3. On success, the next `ontoolresult` from `useToolResult()` clears the
   optimistic value — the card re-renders against the freshly returned object.
4. On error, the hook clears the optimistic value and surfaces `error` to the
   widget for inline display. The widget falls back to the previous value.

The MCP host also pushes `events`-table notifications back over the SSE
bridge (`packages/realtime`), so when the user has the web app open in
parallel both surfaces converge to the same state without manual refresh.

## Audit logging

There is no separate audit path for actions fired from cards. Every mutation
ultimately hits an existing route under `apps/dev/src/routes/`, and those
routes already write a row into the `events` table (the canonical audit log)
in the same transaction as the mutation. The PG `NOTIFY` trigger on `events`
fans the audit row out to all SSE subscribers, which means:

- Every action from a card shows up in the workspace activity feed
  (`apps/web/src/components/activity/`).
- An agent watching the SSE stream sees the same `events` row a human would.
- Forensics (who changed what, when) works identically for card-driven and
  web-app-driven mutations — both carry the same `actorId`.

The card layer adds no audit code on top of this. If a future mutation needs
extra context in the audit row (e.g. _was this fired from a card?_) we'd add
it as a column on the existing `events` schema rather than a parallel log.

## How to add a new action

1. Confirm the mutation lands in a tool that already exists (`update_objects`,
   `delete_object`, `delete_relationship`). If it doesn't, add it to
   `packages/mcp/src/tools.ts` and wire it through the matching `/api/*`
   route — that's where audit + auth get enforced.
2. Add an entry to `MUTATION_POLICY` in
   `apps/web/src/mcp-apps/shared/actions/policy.ts` — pick `confirm: true`
   for anything that's not trivially reversible.
3. Compose a thin `<XAction>` component using `useObjectMutation` +
   `<ActionButton>` (mirror `status-action.tsx` / `owner-action.tsx`).
4. Surface the new affordance from the relevant widget by adding an optional
   handler to `ObjectActionHandlers` in
   `apps/web/src/mcp-apps/shared/widgets/types.ts`.

## Out of scope (tracked for v2 / later)

- One-click hard delete from cards (always behind a confirm dialog in v1).
- Multi-select bulk ops on `ObjectListTable` and `ObjectKanban`.
- Schema mutations from cards (F9 — workspace settings + integration OAuth).
- Action affordances for relationships graph + activity feed (F7).
