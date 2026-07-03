# ADR-0001 — get_objects response-shape architecture

**Status:** Proposed · awaits @Magnus approval
**Bet:** [Maskin MCP returns too many objects/fields, polluting agent context](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/8a75a58c-8408-41b6-9f71-c93b315646fb)
**Direction:** A (locked at bet — surgical `get_objects` fix, do not re-litigate)
**Target file on merge:** `docs/adr/0001-get-objects-response-shape.md` on branch `bet/mcp-response-shape`

---

## Decisions

### 1. Projection site → **MCP handler filter in `packages/mcp/src/server.ts`** (get_objects handler L1449–1535)

Alternative: projection param on `/api/objects/:id/graph` in the API server.

The triple-emit shape (`heroCard.object` / `results[].result.object` / `objects[].object`) is a MCP-only construct — the API tier doesn't know it exists, so killing it is inherently a MCP-tier change. Single-file blast radius vs. multi-service coordination. Follow-up B-bet may push projection down into the API endpoint if bandwidth (not token) cost becomes the binding constraint — for now, MCP handler is the right layer.

### 2. Event-diff computation site → **read-time transform in the MCP get_objects handler**

Alternative: write-time diff computation in the events emitter (with backfill of pre-change rows).

MCP is a thin projection over `/api/objects/:id/graph`. The API's DB rows already carry both `data.updated` and `data.previous` — perfect input for a read-time `{field, old, new}` diff. Write-time change requires touching every emit site in the API tier + a historical-row backfill; over-scope for T1. Explicit trade-off: DB row size stays fat, API→MCP bandwidth stays fat — but token cost, which is the bet's target, drops to just the diff. Historical events benefit immediately (no backfill).

### 3. `include:` param — enum, validation, default

**Zod shape:**
```ts
include: z.array(
  z.enum(['content', 'relationships', 'connected_objects', 'events', 'files'])
).default([]).optional()
```

- **Values:** `content`, `relationships`, `connected_objects`, `events`, `files` (matches AC 2).
- **Unknown values:** Zod rejects at parse time → standard MCP tool error surfaces to the caller. No silent-drop.
- **Default:** `[]` (empty). Lean core: `id, type, title, status, contextLine, url` (matches AC 1).

Alternatives rejected:
- **Per-expansion booleans** (`include_content: boolean`, `include_events: boolean`, …). Matches the only existing precedent in `packages/mcp/src/tools.ts` — `get_session`'s `include_logs: boolean`. Rejected because five orthogonal toggles is a schema smell; the precedent was for one toggle. Cardinality is decisive.
- **Free-form string list** (no enum). Rejected — no validation, no discoverability in the Zod type.

Chosen shape matches SEP-1704's client-driven `_meta.projection` (external precedent linked from the bet).

### 4. Back-compat → **hard cut**

Alternatives:
- **Versioning** (`get_objects_v2` alongside old): rejected — bloats `tools/list`, which is the peer problem the parent bet explicitly targets.
- **Soft-launch flag** (config toggle returning fat shape by default): rejected — delays the whole 4-week measurement window until the flag flips.
- **Hard cut** (default is lean; opt into legacy shape via `include: ['content','relationships','connected_objects','events','files']`): chosen.

MCP callers are our own in-workspace agents; no external contract. Any option that preserves fat-shape default defeats the bet's goal. Adding `include:` is schema-additive so the Zod contract stays valid — old callers that don't pass it just get the lean shape and must add the includes they actually need (T2 rewrites the tool description so agents know which expansions exist).

**Rollback:** revert the PR. Schema stays valid (nobody's using `include:` until we ship). Rolling-kill trigger inherited from the parent bet — bet-qa harness pass rate drops >5 points → revert. Reversible-but-costly; not on the irreversible rail.

### 5. `mcp_tool_response_emitted` PostHog event

**Emit site:** the existing `wrappedHandler` in `packages/mcp/src/server.ts:1278` — the same wrapper that already calls `recordToolCall`. Hooking here gives automatic coverage of every registered MCP tool (needed for the follow-up B-bet's top-5 baseline).

**Properties:**
- `tool_name: string` — the MCP tool that responded (e.g. `get_objects`).
- `response_bytes: number` — `Buffer.byteLength(JSON.stringify(response), 'utf8')` at the wrapper site, computed on the fully-serialized response. Post-serialization is authoritative because it's what actually hits the wire.
- `has_include_param: boolean` — `true` only when the tool defines `include` AND the caller passed a non-empty array. For tools without `include`, always `false`.

**Where in code:** add `recordToolResponse(sink, target, {tool_name, response_bytes, has_include_param})` to `packages/mcp/src/telemetry.ts` alongside `recordToolCall`, `recordMutation`, `recordWidgetEvent`. Emit call goes in `wrappedHandler` directly after the existing `recordToolCall` invocation. Fires on successful responses only (mirrors existing `recordToolCall` semantics, though catching errors for a byte-size metric adds no signal).

---

## Rejected across all decisions (recorded per CLAUDE.md rule)

- **Resource-link pattern** (Microsoft custom-engine / techtaek Tool Context Relay): rejected at the direction-picking stage on the parent bet. Our bloat is structural duplication within a single call (triple-emit + fat `data.updated`+`data.previous` on every event), not raw content per row. Resource-link would move the same duplication behind a fetch step and add a round-trip for data the agent already needs. Held in reserve per informs-linked knowledge — the natural next step if trimmed responses still exceed the 25K Claude Code cap in practice.
- **Pagination envelope** (Google's `has_more` / `next_offset` / `total_count`): `get_objects` isn't a list handler. Envelope is a B-bet concern for `list_objects` / `search_objects`.

## References

- Parent bet audit comment (event 230758) — triple-emit ranking, embedded-snapshot pattern.
- Informs (binding):
  - [Trim MCP tool responses by default — the ecosystem has converged on field projection, pagination metadata, and resource-link fallback](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/a2b939c1-9131-442a-a96c-66bc8d0cecb0)
  - [MCP response shape: consider the resource-link pattern alongside field trimming for large payloads](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/1381be76-3e44-4e0b-83e5-9c787adaaf66)
- External precedent cited in the bet: SEP-1704, Anthropic tool-writing guide (25K Claude Code cap), Google MCP Toolbox.
