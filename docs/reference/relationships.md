---
title: Relationships
slug: relationships
description: The relationship primitive — edge types and how to list and create them between objects.
last_updated: 2026-11-12
---

# Relationships

A relationship is one row in the `relationships` table: a typed, directed edge from a source to a target. Each end is an object, a file, a chat (`conversation`) or a session. The pair (source, target, type) is unique, so creating the same edge twice returns the existing one.

## Edge types

Workspaces start with five types you write yourself: `informs`, `breaks_into`, `blocks`, `relates_to`, `duplicates`. A workspace may add more (call `get_workspace_schema` to see them). The platform writes four more:

| Type | Direction | Written when |
| --- | --- | --- |
| `attached` | object → file | A file is attached to an object. |
| `in_loop` | loop → member object | An object is put into a loop. |
| `spawned` | chat → session | A chat starts an agent session. `metadata.messageId` is the message that started it. |
| `produced_by` | session → object or file | A session creates an object or file. |

## Tools

- `create_relationship` — make an edge. Pass the two ids; the server works out whether each is an object or a file. The tool accepts objects and files only.
- `list_relationships` — list edges. `object_id` matches either end; `source_id`, `target_id` and `type` narrow it. Paginated with a cursor.
- `delete_relationship` — remove one edge by its id.
- `traverse_graph` — walk outward from an object across several hops. Nodes can be objects, files, chats and sessions, but the start must be an object. Filter with `edge_type_allow_list`, otherwise a busy item (a loop member, for example) fills the result with its siblings and is cut off at `max_nodes`.
- `get_objects` with `include: ['relationships']` — the edges around one object, with titles.

## Not covered

Files that arrive in a chat message are recorded in the message's `metadata.attachments` (read them with `list_conversation_messages`). They are not edges.
