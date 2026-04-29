# MCP rendering catalog

Maskin's MCP server returns structured JSON. The web app's `mcp-apps/*`
bundles render those responses inside Claude / Cursor / Claude Desktop. This
document is the contract between the two sides: **which response shape gets
which widget.**

The runtime catalog and TypeScript types live in
`apps/web/src/mcp-apps/shared/widgets/`. This file is the human-readable
reference; if you change the catalog, update both places in the same PR.

## Goals

- Stop every MCP card re-implementing list/detail/graph layouts ad hoc.
- Give designers and product a single page (`/<workspaceId>/dev/mcp-widgets`)
  to iterate on visuals without booting Claude.
- Match the parity benchmark from the parent bet: anything you can do in the
  web app should be doable from the rendered MCP card.

## Primitives

All primitives live in `apps/web/src/mcp-apps/shared/widgets/`. Each accepts
an optional `WorkspaceSchema` (the payload returned by `get_workspace_schema`)
and emits deep links via the `WebAppLink` helper from F2.

| Widget                | File                       | Renders…                                          |
| --------------------- | -------------------------- | ------------------------------------------------- |
| `ObjectCard`          | `object-card.tsx`          | One object — title, body, type/status, deep link. |
| `ObjectListTable`     | `object-list-table.tsx`    | Many objects — scannable shadcn table.            |
| `ObjectKanban`        | `object-kanban.tsx`        | Many objects of one type — status-grouped board.  |
| `RelationshipGraph`   | `relationship-graph.tsx`   | Nodes + edges from `create_objects` graphs etc.   |
| `ActivityFeed`        | `activity-feed.tsx`        | Event stream from `get_events`.                   |

### Shared types

```ts
import type {
  ObjectActionHandlers,
  WorkspaceSchema,
  WidgetKind,
} from '@/mcp-apps/shared/widgets'
```

`ObjectActionHandlers` is the canonical shape for write affordances. Pass
through whichever subset of `onUpdateTitle | onUpdateContent | onUpdateStatus
| onUpdateOwner | onDelete` your card supports — the widget renders the
affordance only when the matching handler is provided.

## Response shape → widget mapping

The dispatcher (`resolveWidget` in `catalog.ts`) walks `WIDGET_CATALOG` in
order and picks the first match. Specific matchers come before generic ones.

| Tool name(s)                             | Response shape                                          | Widget                |
| ---------------------------------------- | ------------------------------------------------------- | --------------------- |
| `create_objects` (graph), `list_relationships` (with nodes) | `{ nodes: GraphNode[]; edges: GraphEdge[] }` | `RelationshipGraph`   |
| `get_events`, entity activity tools       | `EventResponse[]` (or `{ data: EventResponse[] }`)      | `ActivityFeed`        |
| `get_objects` (one id), `update_objects` (one id) | `ObjectResponse` (or singleton list)             | `ObjectCard`          |
| `list_objects`, `search_objects` of one type with repeated statuses | `ObjectResponse[]` (homogeneous)                  | `ObjectKanban`        |
| `list_objects`, `search_objects`, `get_objects` (many) | `ObjectResponse[]`                                | `ObjectListTable`     |

Notes:

- **Envelope** — every matcher unwraps `{ data: T }` once; the API returns
  paged lists under `data` while detail responses are bare objects.
- **Heterogeneous lists** fall through to `ObjectListTable` because grouping
  by status across object types is misleading.
- **Schema gating** — when no `WorkspaceSchema` is available the kanban falls
  back to insertion-order columns; the table and card just lose their
  `display_name` overrides.

## How to add a new widget

1. Drop a `.tsx` file into `apps/web/src/mcp-apps/shared/widgets/`.
2. Re-export from `widgets/index.ts`.
3. Add the catalog entry to `widgets/catalog.ts`. Place it before any more
   generic matcher (e.g. before `object_list_table`, the catch-all fallback).
4. Document the response-shape mapping in the table above.
5. Add a tab to the sandbox (`apps/web/src/routes/_authed/$workspaceId/dev/mcp-widgets.tsx`)
   so designers can see it without server changes.
6. Wire it up from the relevant `mcp-apps/<feature>/app.tsx` consumer.

## Sandbox

`/<workspaceId>/dev/mcp-widgets` mounts every primitive against fixture data.
The route is intentionally hidden from the main nav — it's a developer tool,
not a feature surface. Use it when iterating on visuals or before reviewing a
schema-driven change.

## Out of scope (for the catalog stub)

- Drag-and-drop status changes on the kanban (planned for F7).
- Canvas-based graph rendering (planned for F7; current `RelationshipGraph`
  is a list-of-edges fallback).
- Full edit-in-place for `ObjectCard` (`ObjectDocumentView` swap planned for
  F7 once the parity benchmark in the bet is being measured).

## Related work

- F2 — deep-link helper (`WebAppLink`, `useWebAppHref`, `buildWebAppPath`).
- F7 / F8 — Wave 2/3 cards consume this catalog; if you find yourself
  re-rolling a list/detail/kanban inside one of those tasks, the right move
  is to extend the catalog instead.
