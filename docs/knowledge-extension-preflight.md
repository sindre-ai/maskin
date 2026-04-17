# Knowledge Extension — Pre-flight memo (Task 1)

Audit produced by Task 1 of the Knowledge Extension bet (`25f17ad9-eca4-4d68-84f6-6a295d8bce1a`). Each downstream task (2–7) should look here before touching code.

All paths relative to the repo root. All line numbers as of the current HEAD of branch `claude/knowledge-graph-design-YsihU`.

---

## 1. Extension loader — where code-level extensions register at boot

Status: ✅ the bet's model matches the current code.

- Module-SDK types: `packages/module-sdk/src/types.ts`
  - `ModuleDefinition` — lines 56–71 (`id`, `name`, `objectTypes`, `routes`, `mcpTools`, `defaultSettings`).
  - `ModuleWebDefinition` — lines 156–167 (`navItems`, `objectTypeTabs`, `defaultSettings`).
  - `ObjectTypeDefinition` — lines 16–29 (`type`, `label`, `icon`, `defaultStatuses`, `defaultFields`, `defaultRelationshipTypes`).
  - `FieldDefinition` — lines 8–13 (`name`, `type`, `required?`, `values?`).
- Server registry: `packages/module-sdk/src/registry.ts` — `registerModule()` / `getAllModules()` around lines 88–95.
- Web registry: same file, `registerWebModule()` / `getAllWebModules()` / `getEnabledObjectTypeTabs()` around lines 139–173.
- Server boot wiring: `apps/dev/src/extensions.ts` — imports each extension's server module and calls `registerModule()`. It is imported for side effects from `apps/dev/src/index.ts:1`.
- Web boot wiring: `apps/web/src/lib/extensions.ts` — same pattern with `registerWebModule()`.

The `work` extension at `extensions/work/{server,web}/index.ts` is the canonical reference shape.

> Note on current branch state: commit `533d163` on this branch already scaffolds `extensions/knowledge/{server,web}` and wires it into both boot files. That is strictly Task 7's scope (code-level extension). Task 3 (runtime registration via MCP) should be run BEFORE this code is merged to `main`, or the `create_extension` call needs to change shape — see Item 2 below.

---

## 2. `create_extension` MCP tool — does it accept the bet's payload?

Status: ✅ the validator and persistence both support everything the bet needs — **with one important caveat about Item 7 / branch state**.

- Schema (Zod): `packages/mcp/src/tools.ts`, lines 605–638. Shape:
  - `object_types[].type`           — string, regex `/^[a-z][a-z0-9_]*$/`.
  - `object_types[].display_name`   — string.
  - `object_types[].statuses`       — `z.array(z.string()).min(1)`.
  - `object_types[].fields`         — `{ name, type: 'text'|'number'|'date'|'enum'|'boolean', required?: boolean, values?: string[] }[]`, defaults to `[]`.
  - `object_types[].relationship_types` — `z.array(z.string()).optional()`.
- Handler: `packages/mcp/src/server.ts`, lines 1385–1499.
  - For each `object_type`: writes `statuses[type]`, `display_names[type]`, `field_definitions[type]`, and appends to `relationship_types` and `custom_extensions`.
  - Persists to `workspace.settings` via `PATCH /api/workspaces/{id}`.
- Exposure: `get_workspace_schema` in `packages/mcp/src/server.ts` (around lines 699–717) reflects the saved settings back as `statuses`, `fieldDefinitions`, `relationshipTypes`.

The bet's payload (`summary/text required`, `confidence/enum/[low,medium,high]`, `tags/text`, `last_validated_at/date`, relationship types `supersedes|contradicts|about`) fits 1:1.

**⚠️ Caveat — interaction with the branch's existing code-level `knowledge` extension.**

`create_extension` branches on whether `args.id` matches a registered module (`packages/mcp/src/server.ts:1388`):

- If `knowledge` is **already code-registered** (current branch state after `533d163`), passing `object_types` to `create_extension({id:'knowledge', object_types:[…]})` throws at line 1392 (`"knowledge" is a registered extension and cannot have custom object_types…`). In that case Task 3 must call `create_extension({workspace_id, id:'knowledge'})` **with no `object_types`** to just enable it; the type definitions come from the code-level module.
- If `knowledge` is **not code-registered** (original bet assumption), the bet's full payload works as-is.

**Recommendation for Task 3:** check `list_extensions` first. If `knowledge` already shows up as an available (code-registered) module, call `create_extension` with just `{id:'knowledge'}`; otherwise send the full payload. Either way, the workspace `settings.statuses.knowledge` / `settings.field_definitions.knowledge` / `settings.relationship_types` should end up correct.

No MCP-layer work is needed in Task 2 for the extension surface itself. See Item 3 for the one real gap.

---

## 3. Relationship-type whitelist — can we add `supersedes | contradicts | about` without a code change?

Status: ✅ **the whitelist is not enforced**, so new types can be added today. There is nothing for Task 2 to do here either.

- DB column: `packages/db/src/schema.ts:100` — `relationships.type = text('type').notNull()`. Plain text, no enum.
- Migration: `packages/db/drizzle/0000_setup.sql:52–62` confirms the same — no `CREATE TYPE`, no `CHECK`, unique only on `(source_id, target_id, type)`.
- Route validator: `packages/shared/src/schemas/relationships.ts:8` — `type: z.string()`. No enum, no allow-list.
- Workspace settings default: `packages/shared/src/schemas/workspaces.ts:31–33` — defaults to `['informs','breaks_into','blocks','relates_to','duplicates']`, but nothing consults that list at write time.

Net: any string already flows through end-to-end. Adding `supersedes`, `contradicts`, `about` to `settings.relationship_types` (which `create_extension` already does — see Item 2) is purely documentary and for the UI's benefit. No DB or Zod change required.

> Follow-up worth noting (not in this bet): the whitelist is unenforced. If we ever care about data integrity we'd either add a `CHECK` constraint or wire `settings.relationship_types` into `createRelationshipSchema`. Deferred — the bet explicitly wants 0 schema migrations.

---

## 4. Default actor system prompt — where to land the knowledge read/write nudges (Task 5)

Status: ⚠️ **the bet's assumption of a single default needs revision.** There is no one place that stamps a default.

- Column: `actors.system_prompt` is stored per-actor (`apps/dev/src/routes/actors.ts:116`: `systemPrompt: body.system_prompt`). Nullable. Whatever the caller sends is what ends up on the row; no default is applied server-side.
- Fallback at session start: `apps/dev/src/services/session-manager.ts:466` — if an actor's `systemPrompt` is `null/undefined`, the container gets `SYSTEM_PROMPT=You are a helpful AI agent.` Short, boilerplate; not a knowledge-aware template.
- Where prompts are authored for new workspaces:
  - `packages/db/src/seed.ts` — seed actors: `Insight Clusterer` (line 61), `Bet Decomposer` (line 96).
  - `packages/shared/src/templates/development-agents.ts` — `Bet Planner` (line 69), `Senior Developer` (line 89), `Code Reviewer` (line 109), `CTO` (line 133), `Development Driver` (line 160), `Workspace Observer` (line 206), `Insight Curator` (line 228).
  - `packages/shared/src/templates/growth-agents.ts` — similar list for the growth template.
  - `packages/shared/src/templates/outbound-sales-agents.ts` — similar for outbound sales.

Each of those files defines a literal `systemPrompt: \`…\`` string per agent role. There is no shared preamble mechanism today.

**Implications for Task 5** (original plan: "append two lines to one file"):

1. The knowledge read + write nudges need to be applied in more than one place. Two realistic options:
   - **A. Spray** — paste the two lines into every `systemPrompt` string in the three template files, plus the two seed prompts in `packages/db/src/seed.ts`. Simple, but duplicated text; changing them later is an N-way edit.
   - **B. Shared constant + session-time injection** — introduce a `KNOWLEDGE_NUDGES` string in `packages/shared/src/prompts.ts` (or similar) and either (i) prepend it to each `systemPrompt` in the templates/seed (still spray, but from one source of truth) or (ii) have `session-manager.ts` prepend it when building the container env (`SYSTEM_PROMPT = KNOWLEDGE_NUDGES + "\n\n" + (agent.systemPrompt ?? fallback)`).
   - Option B(ii) is the minimal, single-point change and it also covers the boilerplate fallback at `session-manager.ts:466`.
2. Existing actors: only new actors get updated template prompts anyway (they are stamped at insert). Option B(ii) is the only way to affect already-created actors without rewriting rows; since the bet wants "the nudge lands consistently for new agents", option B(ii) is the cleanest fit.
3. Conservative default (matching the bet's "don't rewrite existing actors" guidance): pick **B(i)** — new `KNOWLEDGE_NUDGES` constant, prepended in the three template files and the two seed prompts only. New actors seeded from any template pick it up; existing actors are untouched.

Task 5 should choose between B(i) and B(ii) before starting. No Task 2 work is required either way — this is just a Task 5 scoping call.

---

## 5. Object list UI and object-type tabs

Status: ✅ declarative — adding the Knowledge tab is automatic once the extension is registered/enabled.

- Detail view: `apps/web/src/components/objects/object-document.tsx` — renders title, markdown content (editable), status selector, metadata, and the linked-objects panel. Reused across all object types.
- Relationships panel: `apps/web/src/components/objects/linked-objects.tsx` — lists inbound/outbound edges with relationship type labels; already handles arbitrary relationship type strings (confirms Item 3).
- Objects list page: `apps/web/src/routes/_authed/$workspaceId/objects/index.tsx`.
  - Imports `getEnabledObjectTypeTabs` from `@maskin/module-sdk` (line 18).
  - Builds tabs at lines 76–84 via `getEnabledObjectTypeTabs(enabledModules)` + any `customExtensions` tabs.
- Tab source: `getEnabledObjectTypeTabs()` in `packages/module-sdk/src/registry.ts:164` iterates `getAllWebModules()` and flattens each module's `objectTypeTabs`.

Adding the Knowledge tab is a two-liner in `extensions/knowledge/web/index.ts`:

```ts
objectTypeTabs: [{ label: 'Knowledge', value: 'knowledge' }]
```

…which the branch's existing `extensions/knowledge/web/index.ts` (line 8) already does. Task 4 is essentially already complete on the branch; Task 4's work should mostly be verification + any polish.

---

## 6. Per-actor `agent_files` — no overlap with the new workspace-scoped knowledge layer

Status: ✅ distinct surface, no collisions.

- Schema: `packages/db/src/schema.ts:227–249` — table `agent_files`:
  - `id` uuid PK
  - `actorId` uuid (FK → actors)
  - `workspaceId` uuid (FK → workspaces)
  - `fileType` text NOT NULL — values used today: `'learning'`, `'memory'` (also sometimes `'skill'` or `'workspace'` scaffolding depending on session-manager paths)
  - `path`, `storageKey`, `sizeBytes`, `sessionId`, timestamps
  - Index on `(actorId, fileType)`
- Writers: `apps/dev/src/services/agent-storage.ts`
  - `pushAgentFiles()` writes `learning` entries (~lines 66–74) and `memory` entries (~lines 81–102) after session end.
  - `getFile()` / `listFileRecords()` at ~lines 114–132 read by `fileType`.
- Session integration: `apps/dev/src/services/session-manager.ts` mounts `skills`, `learnings`, `memory`, `workspace` subdirs at ~line 158 and calls `pullAgentFiles()` (~line 165) to hydrate them from S3 before container start.

These files are S3-backed, per-actor, private. The knowledge extension uses the `objects` table with `type='knowledge'`, which is workspace-scoped and multi-reader. The two surfaces share nothing — we just need to keep them conceptually separated in docs: "what this agent remembers" vs "what this workspace knows."

No change needed here.

---

## Summary for downstream tasks

| Task | Blocked by a gap? | Notes |
|------|-------------------|-------|
| 2. Close MCP/schema gaps | **No** | `create_extension` already accepts `fields`, `statuses`, `relationship_types`. Relationship type enforcement is non-existent, which is actually what the bet wants. Close Task 2 as "no gap; see this memo." |
| 3. Register `knowledge` extension at runtime | **No**, but adjust the call | See Item 2 caveat: check `list_extensions` first. If `knowledge` is already code-registered on this branch, call `create_extension({id:'knowledge'})` without `object_types`; otherwise send the full payload. |
| 4. Add "Knowledge" object-type tab in the web app | **No** | Already done on the branch (`extensions/knowledge/web/index.ts:8`). Task 4 reduces to verification. |
| 5. Update default actor system prompt | **Scoping call required** — see Item 4 | There is no single default. Pick option B(i) (shared `KNOWLEDGE_NUDGES` constant, spray into all template prompts) or B(ii) (prepend in `session-manager.ts` env build). B(i) matches the bet's "don't rewrite existing actors" default; B(ii) is a true one-line change. |
| 6. End-to-end verification | **No** | Standard smoke test against the Development workspace. |
| 7. (Optional) promote to code-level extension | **Already done** on this branch in commit `533d163`. Downstream tasks should treat that commit as the Task 7 deliverable. |

The bet's "0 schema migrations, 0 core code changes, 1 MCP call" scorecard still holds — the runtime-registration path is intact. The only true deviation is that Item 4 is more nuanced than the bet suggested, and Task 5's plan needs one scoping decision before it starts.
