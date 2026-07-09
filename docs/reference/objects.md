---
title: Objects
slug: objects
description: The base object model shared by every Maskin entity — create, get, update, delete, and metadata semantics.
last_updated: 2026-07-09
---

# Objects

> A Maskin object is a single row in the unified `objects` table — a typed entity (bet, task, insight, meeting, or any workspace-defined type) with a title, status, free-form JSON metadata, and edges to other objects.

Every first-class thing you work with in a Maskin workspace — a bet, a task, an insight, a meeting — is a row in one shared `objects` table with a `type` column. That means the same four CRUD tools cover them all: `create_objects`, `get_objects`, `update_objects`, `delete_object`. Types and per-type statuses are defined by the workspace schema (see [workspace-schema.md](./workspace-schema.md)); call `get_workspace_schema` first if you don't already know which types and statuses are valid.

## Above the fold — create one object

```json
{
  "tool": "create_objects",
  "arguments": {
    "nodes": [
      {
        "$id": "n1",
        "type": "task",
        "title": "Write objects.md",
        "status": "todo"
      }
    ]
  }
}
```

Returns the created node with a server-assigned UUID. `$id` is a client-side temporary handle used to reference the node from `edges` in the same call — it never appears in the returned data.

---

## `create_objects`

Create one or more objects, optionally with relationships between them, in a single atomic operation. All nodes and edges succeed together or the whole call rolls back.

For a single object, pass one node and no edges. For a graph — a bet with three child tasks, an insight `informs` a bet, etc. — pass all nodes in one call and use `$id` handles in `edges` to link them. Edges may also reference the UUIDs of objects that already exist in the workspace, so you can attach new objects to existing ones in the same call.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `nodes` | `array` (1–50) | yes | Objects to create. |
| `nodes[].$id` | `string` | yes | Client-side temporary ID for cross-referencing in `edges`. Never sent back to you. |
| `nodes[].type` | `string` | yes | Object type (e.g. `insight`, `bet`, `task`, `meeting`). Must be a type enabled on the workspace. |
| `nodes[].status` | `string` | yes | Must be a valid status for `type` in this workspace. Defaults: insight → `new\|processing\|clustered\|scored\|parked\|discarded`; bet → `signal\|qualified\|define\|active\|live\|succeeded\|failed\|paused`; task → `todo\|in_progress\|in_review\|validated\|done\|discarded`. |
| `nodes[].title` | `string` | no | Human-readable title. |
| `nodes[].content` | `string` | no | Markdown body — the object's spec / description. |
| `nodes[].metadata` | `object` | no | Free-form key/value custom fields. Call `get_workspace_schema` to see what's defined. |
| `nodes[].driver` | `uuid` | no | Actor (human or agent) responsible for the object. |
| `nodes[].file_ids` | `uuid[]` | no | Existing file IDs to attach. Upload first with `create_file`. Each becomes an `attached` relationship. |
| `edges` | `array` | no | Relationships to create between new and/or existing objects. Defaults to `[]`. |
| `edges[].source` | `string` | yes | A `$id` from a node in this request, or the UUID of an existing object. |
| `edges[].target` | `string` | yes | A `$id` from a node in this request, or the UUID of an existing object. |
| `edges[].type` | `string` | yes | Relationship type: `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`. |
| `workspace_id` | `uuid` | no | Workspace to write to. Defaults to `DEFAULT_WORKSPACE_ID`. |

### Non-trivial example — a bet with two child tasks in one call

```json
{
  "tool": "create_objects",
  "arguments": {
    "nodes": [
      {
        "$id": "bet",
        "type": "bet",
        "title": "Ship the search redesign",
        "status": "active",
        "content": "## Success\nSearch success rate >= 60% by 2026-08-01."
      },
      {
        "$id": "t1",
        "type": "task",
        "title": "Rewrite ranking",
        "status": "todo"
      },
      {
        "$id": "t2",
        "type": "task",
        "title": "New empty state",
        "status": "todo"
      }
    ],
    "edges": [
      { "source": "bet", "target": "t1", "type": "breaks_into" },
      { "source": "bet", "target": "t2", "type": "breaks_into" }
    ]
  }
}
```

Both tasks are created, both edges are created, all four writes commit or roll back together.

### REST equivalent

For a single object, `POST /api/objects`. For a multi-node atomic create like the example above, `POST /api/graph`.

```bash
# Single object
curl -X POST https://<host>/api/objects \
  -H "Authorization: Bearer $MASKIN_API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{"type":"task","title":"Write objects.md","status":"todo"}'

# Graph create — nodes + edges in one transaction
curl -X POST https://<host>/api/graph \
  -H "Authorization: Bearer $MASKIN_API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "nodes": [
      {"$id":"bet","type":"bet","title":"Ship the search redesign","status":"active"},
      {"$id":"t1","type":"task","title":"Rewrite ranking","status":"todo"}
    ],
    "edges": [{"source":"bet","target":"t1","type":"breaks_into"}]
  }'
```

---

## `get_objects`

Fetch one or more objects by ID. Returns a minimal core payload per object by default, and adds richer blocks only when you ask for them via `include`.

### Default response shape

Each returned object always carries these fields — nothing else:

- `id` — UUID
- `type` — object type
- `title` — human-readable title (may be `null`)
- `status` — current status
- `contextLine` — one-line human summary (e.g. `in_progress · driver Developer`)
- `url` — direct link to the object in the Maskin UI
- `workspaceId` — UUID of the owning workspace

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ids` | `uuid[]` (1–50) | yes | Object IDs to fetch. |
| `include` | `string[]` | no | Opt-in blocks. See table below. Defaults to `[]`. |
| `workspace_id` | `uuid` | no | Workspace to read from. Defaults to `DEFAULT_WORKSPACE_ID`. |

### Available `include` blocks

Each value in `include` adds exactly one block to every returned object:

| Value | Adds |
|-------|------|
| `content` | The object's body/description (markdown). |
| `metadata` | Custom field values (`metadata` JSON). |
| `relationships` | Inbound and outbound edges, each with `sourceTitle` and `targetTitle`. |
| `connected_objects` | The objects on the other end of those edges (default core shape each). |
| `events` | Recent lifecycle changes and comments. |
| `files` | Metadata for files attached to the object or its comments. |

### Minimal example

```json
{
  "tool": "get_objects",
  "arguments": {
    "ids": ["fa89765f-2997-4e45-a679-3aa41c8b08c2"]
  }
}
```

### Non-trivial example — the full picture for one object

```json
{
  "tool": "get_objects",
  "arguments": {
    "ids": ["fa89765f-2997-4e45-a679-3aa41c8b08c2"],
    "include": ["content", "metadata", "relationships", "connected_objects", "events"]
  }
}
```

`include` is additive: every listed block is added to every object in `ids`. Omitting `include` gives you the seven core fields per object — nothing more. Ask for `metadata` and you get metadata; ask for `relationships` and `connected_objects` together and you get the full local neighborhood in one round-trip.

### REST equivalent

Single object, core fields:

```bash
curl -H "Authorization: Bearer $MASKIN_API_KEY" \
  https://<host>/api/objects/<id>
```

Object with all its edges, connected objects, events, and files in one call — the closest REST analog of `get_objects` with a full `include`:

```bash
curl -H "Authorization: Bearer $MASKIN_API_KEY" \
  https://<host>/api/objects/<id>/graph
```

To fetch several objects at once via REST, pass a comma-separated list to `GET /api/objects?ids=<uuid1>,<uuid2>`.

---

## `update_objects`

Update one or more existing objects and/or create relationships between existing objects. Provide `updates`, `edges`, or both — at least one is required.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `updates` | `array` | no† | Objects to update. Defaults to `[]`. |
| `updates[].id` | `uuid` | yes | Target object. |
| `updates[].title` | `string` | no | New title. |
| `updates[].content` | `string` | no | New markdown body. |
| `updates[].status` | `string` | no | New status. Must be valid for the object's type in this workspace. |
| `updates[].metadata` | `object` | no | Key/value patch. **Shallow-merged** — see below. |
| `updates[].driver` | `uuid \| null` | no | Set a new driver, or pass `null` to clear the driver. |
| `updates[].attach_file_ids` | `uuid[]` | no | Existing file IDs to attach. Already-attached files are skipped. |
| `updates[].detach_file_ids` | `uuid[]` | no | File IDs to detach. Removes the `attached` relationship row; leaves the file itself untouched (use `delete_file` if you also want the file gone). |
| `edges` | `array` | no† | Relationships to create between existing objects. Defaults to `[]`. |
| `edges[].source_id` | `uuid` | yes | Source object UUID. |
| `edges[].target_id` | `uuid` | yes | Target object UUID. |
| `edges[].type` | `string` | yes | `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`. |
| `workspace_id` | `uuid` | no | Workspace to write to. Defaults to `DEFAULT_WORKSPACE_ID`. |

† At least one of `updates` or `edges` must be provided.

### Metadata patch semantics — shallow merge

`metadata` is **shallow-merged with the existing row**: keys you send are added or overwritten, keys you leave out are preserved. There is no field-level delete — writing `null` for a key sets the value to `null`, it does not remove the key.

If an object already has `metadata: { "priority": "high", "owner_squad": "search" }` and you call:

```json
{
  "tool": "update_objects",
  "arguments": {
    "updates": [
      {
        "id": "...",
        "metadata": { "priority": "low", "eta": "2026-08-01" }
      }
    ]
  }
}
```

the resulting metadata is `{ "priority": "low", "owner_squad": "search", "eta": "2026-08-01" }`. `owner_squad` survives untouched because you didn't mention it.

### Non-trivial example — status change + edge in one call

```json
{
  "tool": "update_objects",
  "arguments": {
    "updates": [
      { "id": "<task-uuid>", "status": "in_review" }
    ],
    "edges": [
      { "source_id": "<insight-uuid>", "target_id": "<bet-uuid>", "type": "informs" }
    ]
  }
}
```

Both changes commit together. Every mutation writes to the workspace event log, so status changes and new edges show up on the SSE stream and in `get_events`.

### REST equivalent

```bash
# Update fields on one object
curl -X PATCH https://<host>/api/objects/<id> \
  -H "Authorization: Bearer $MASKIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"in_review","metadata":{"priority":"low","eta":"2026-08-01"}}'

# Create a relationship between two existing objects
curl -X POST https://<host>/api/relationships \
  -H "Authorization: Bearer $MASKIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"source_id":"<insight-uuid>","target_id":"<bet-uuid>","type":"informs"}'
```

REST splits the two writes across two endpoints and two transactions; the MCP tool does both in one atomic call.

---

## `delete_object`

Hard-delete a single object by ID.

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | `uuid` | yes | Object to delete. |
| `workspace_id` | `uuid` | no | Workspace the object lives in. Defaults to `DEFAULT_WORKSPACE_ID`. |

### Hard-delete semantics — what actually gets removed

`delete_object` runs a single transaction that:

1. Deletes any `subscriptions` rows pointing at the object (polymorphic — not FK'd, so they must be cleared explicitly).
2. Deletes any `read_state` rows pointing at the object (same reason).
3. Deletes the `objects` row itself.
4. Inserts a `deleted` row in the workspace `events` log so the SSE feed and audit trail stay honest.

There is no soft-delete flag, no undo, and no restore endpoint. Related edges in the `relationships` table cascade via foreign key. Comments and files are not automatically deleted — they become orphaned by object ID and should be cleaned up separately if needed.

### Minimal example

```json
{
  "tool": "delete_object",
  "arguments": {
    "id": "fa89765f-2997-4e45-a679-3aa41c8b08c2"
  }
}
```

### REST equivalent

```bash
curl -X DELETE https://<host>/api/objects/<id> \
  -H "Authorization: Bearer $MASKIN_API_KEY"
```

Response: `{ "deleted": true }` on success, `404` if the object doesn't exist or the caller isn't a member of its workspace.

---

## See also

- [bets.md](./bets.md) — the `bet` object type: shaped, time-boxed outcomes and their lifecycle statuses.
- [tasks.md](./tasks.md) — the `task` object type: units of work under a bet, driver handoff, and review flow.
- [relationships.md](./relationships.md) — the edge types (`breaks_into`, `informs`, `blocks`, `relates_to`, `duplicates`) referenced in `create_objects.edges` and `update_objects.edges`.
- [mcp-tools.md](./mcp-tools.md) — the full Maskin MCP tool catalog, including `list_objects`, `search_objects`, `get_workspace_schema`, and the file / comment / relationship tools referenced from this page.
