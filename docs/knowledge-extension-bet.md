# Bet: Knowledge Extension — self-improving workspace wiki for humans + agents

**One-liner:** Ship a Maskin extension that turns mid-session corrections ("don't use `analytics.customers_raw`, use `dim_customers`") into durable, shared, workspace-scoped knowledge articles that both humans browse like a wiki and agents retrieve on demand. Pattern: Karpathy's "LLM Wiki" (Apr 2026), mapped onto primitives Maskin already has.

---

## Implementation status (as of 2026-04-17)

V1 has shipped on branch `claude/code-review-9dgQg`. Three deviations from the original spec below, recorded here so the spec doesn't diverge from what exists:

1. **Registered as code, not via runtime `create_extension`.** The extension lives at `extensions/knowledge/{server,web,shared}.ts` and is registered in `apps/dev/src/extensions.ts` + `apps/web/src/lib/extensions.ts` alongside the `work` extension. §183's two options collapsed into one: code-level from day 1. See commit `533d163`.
2. **Opt-in per workspace.** Knowledge is NOT in the default `enabled_modules` (still `['work']`). Workspaces opt in by adding `'knowledge'` to `settings.enabled_modules`. This keeps the feature off for workspaces that don't want it.
3. **Read-path nudge is injected at session launch, not stamped into actor rows.** Because knowledge is opt-in, the "search knowledge before answering" line can't live in every seeded agent's `systemPrompt` — it would prompt agents in knowledge-disabled workspaces to call a type that doesn't exist. Instead `apps/dev/src/services/agent-prompt.ts` appends `KNOWLEDGE_NUDGES` to `SYSTEM_PROMPT` at container launch, but only when the workspace has `knowledge` in `enabled_modules`. This supersedes the §142 "no session-manager change" rationale.

Deferred per §152 and still deferred: curator/lint agent, pgvector, graph viz page, draft approval flow, dedicated `capture_knowledge` MCP helpers.

Not yet executed: the 7-step runtime Verification checklist below. Those are smoke tests that need `pnpm dev` + a browser.

---

## Why

Today, when a user corrects an agent or realizes a data-model truth mid-session, that correction dies with the session. It doesn't:

- carry forward to the next session,
- become visible to other humans in the workspace,
- update what *other* agents believe about the data model,
- or resurface at the right moment to prevent the same mistake.

Multiplayer workspaces compound the loss: three agents and two humans can each learn the same truth independently, and none of them share it.

We want a **workspace-scoped, self-improving knowledge base** that humans browse like a wiki and agents read at the right moment — and that gets richer automatically as the team works.

## The pattern: Karpathy's LLM Wiki

From [Karpathy's tweet](https://x.com/karpathy/status/2039805659525644595) and [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) (Apr 2026):

- `raw/` — immutable sources (observations, transcripts, corrections)
- `wiki/` — synthesized, durable markdown articles that compile those sources into truth, maintained by the LLM
- **Ingest / Query / Lint** — three operations on top
- Retrieval is *not* RAG. The agent **reads whole articles** from the wiki; chunks don't get shredded. Knowledge **compounds** as the LLM rewrites the coherent whole instead of appending chunks.

[v2 community extensions](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2) add: confidence, typed edges (`@supersedes`, `@contradicts`), multi-agent merge. We'll borrow lightly.

## The Maskin mapping

| Karpathy concept | Maskin primitive | Why it fits |
|---|---|---|
| `raw/` sources | `events`, `session_logs`, existing `objects` | Already append-only, workspace-scoped, UUID-referenceable. Nothing to build. |
| `wiki/*.md` articles | `objects` with `type='knowledge'` | Unified table, JSONB metadata, status, markdown `content`. No schema change. |
| `index.md` | `GET /api/objects?type=knowledge` + a frontend tab | Derived. No storage. |
| `log.md` | `events` table | Every mutation is already logged. |
| Wikilinks, `@supersedes`, `@contradicts` | `relationships` table with new `type` values | Universal typed edge table. Just strings. |
| Multiplayer sync | `workspaces` + `workspace_members` + PG NOTIFY → SSE | Already live-updating. Zero new plumbing. |

Every moving part already exists. We're adding a convention, not a subsystem.

## Why a new object type — and not just `insight` with `status='validated'`?

Worth defending up front. We already have `insight` (type) with statuses `new | processing | clustered | discarded`. Why not `type='insight', status='validated'`?

Because the lifecycles are genuinely different:

- **Insight** is a *raw observation* — "user mentioned X in a meeting", "agent noticed Y pattern". It's the Karpathy `raw/`.
- **Knowledge** is a *synthesized, durable article* — "here's how customer data is organized in our stack". It's the Karpathy `wiki/`.

Insights feed knowledge creation (via `informs` edges), but they have different fields, different statuses, different display, and different consumers. Conflating them would force every consumer to filter by status, and would lose the clean "raw vs compiled" distinction that makes the pattern work. One new type is cheap (one string, one `create_extension` call) and keeps the two roles clean.

## Architecture — minimum surface area

**Scorecard:**

- 1 new object type (`knowledge`)
- 3 new relationship types (`supersedes`, `contradicts`, `about`) — all just strings
- **0 new MCP tools** — reuse `create_objects`, `search_objects`, `get_objects`, `list_relationships`
- **0 new routes, 0 new Zod packages, 0 schema migrations**
- **0 core code changes** — ship entirely via one `create_extension` MCP call at runtime
- Frontend: reuses `object-document.tsx`, `linked-objects.tsx`, existing markdown renderer — the extension's `objectTypeTab` surfaces Knowledge alongside Bets, Tasks, Insights

## Data model — declared in one `create_extension` call

No migrations, no defaults files, no shared Zod. The entire data model is the payload of one MCP call:

```ts
create_extension({
  workspace_id: "<dev-workspace-id>",
  id: "knowledge",
  name: "Knowledge",
  object_types: [{
    type: "knowledge",
    display_name: "Article",
    statuses: ["draft", "validated", "deprecated"],
    fields: [
      { name: "summary",            type: "text",    required: true  },
      { name: "confidence",         type: "enum",    values: ["low","medium","high"] },
      { name: "tags",               type: "text"     },
      { name: "last_validated_at",  type: "date"     },
    ],
    relationship_types: ["supersedes", "contradicts", "about"],
  }],
})
```

**Field rationale:**
- `summary` — one-liner used in listings and (later) in any agent-facing index. Required so it always exists.
- `confidence` — low/medium/high. Lets agents weight articles when they find multiple on a topic.
- `tags` — faceted browse in the UI.
- `last_validated_at` — set when a human confirms the article is still true. Enables staleness detection later.

**Relationship rationale:**
- `supersedes` — new article replaces old. Lets the frontend grey out the old one automatically.
- `contradicts` — two articles disagree. Curators (later) resolve; the edge is the flag.
- `about` — a knowledge article is *about* a specific bet/task/insight. Lets an agent working on that bet pull the relevant knowledge directly.

For provenance (which session/event produced the article), reuse the existing `informs` edge — no new type needed.

## Write path — inline, one existing tool

Anyone (human or agent) creates a knowledge article by calling the existing `create_objects` MCP tool with `type='knowledge'`. The agent mid-session that hears "actually, use `dim_customers`" captures it inline — no new primitive, no new workflow.

```ts
create_objects({
  workspace_id,
  objects: [{
    type: "knowledge",
    title: "Customer data: canonical table",
    content: "Use `analytics.dim_customers`. The `analytics.customers_raw` table is a staging table and should not be queried directly for analytics.\n\n...",
    status: "validated",
    metadata: {
      summary: "Canonical customer table is `analytics.dim_customers`.",
      confidence: "high",
      tags: ["databricks", "customers"],
    },
  }],
  relationships: [
    // Maskin relationships are object-to-object. When an agent creates a knowledge
    // article while working on a specific bet/task/insight, the provenance edge
    // goes from that triggering object to the new article.
    { type: "informs", source_id: "<triggering-object-id>", target_id: "<new-article-id>" },
  ],
})
```

Humans writing knowledge use the **existing** object detail page (`apps/web/src/components/objects/object-document.tsx`) — already renders markdown, supports inline edit, shows linked objects. The extension adds `knowledge` as a type tab the same way `work` adds "Bets".

## Read path — agent searches on demand

The agent retrieves knowledge the way Karpathy's pattern intends: it **reads the wiki**, rather than having it pre-loaded.

**Mechanism:** two paragraphs (`KNOWLEDGE_NUDGES` in `packages/shared/src/prompts.ts`) that the session manager appends to `SYSTEM_PROMPT` at container launch, **only in workspaces that have the knowledge module enabled**:

> "Before answering domain questions or making assumptions about data, schemas, or tooling, call `search_objects({type:'knowledge', q:'<terms>'})`. If relevant titles come back, call `get_objects({id})` to read the full article.
>
> When the user corrects a factual assumption, establishes a data-model or tooling truth, or validates a non-obvious convention worth keeping past this session, call `create_objects({type:'knowledge', ...})`. If you were triggered by a specific object (bet, task, or insight), add an informs relationship from that object to the new knowledge article."

Reasons:

- **Karpathy's own point:** the agent should *read* the wiki on demand, not have it shoved in at boot. The whole value of the pattern is that the agent treats knowledge like a folder it grep/cats.
- **Staleness:** a pre-stuffed index goes stale the moment another user edits an article mid-session. On-demand search is always fresh.
- **Token economy:** in a workspace with 200 articles, maybe 3 matter for a given task. Pre-injecting 200 titles wastes 197 of them.
- **Opt-in hygiene:** injecting at session launch (rather than baking the nudge into every seeded agent) means knowledge-disabled workspaces don't end up with agents calling a type that doesn't exist. The extra code is one helper (`apps/dev/src/services/agent-prompt.ts`).

If scale becomes a problem (thousands of articles, ILIKE stops discriminating), add pgvector as a focused Phase 2 — `search_objects` grows a semantic mode; the MCP surface stays unchanged.

## Multiplayer — free

`objects` and `relationships` are workspace-scoped. `workspace_members` controls access. Every mutation emits an event, PG NOTIFY fires, the SSE bridge pushes to every open browser and every live session. Two humans + three agents in one workspace see the same knowledge graph update live. **No new plumbing.**

**Per-actor vs workspace split:** An individual agent's *private* learnings still live in the existing per-actor `agent_files` (`fileType='learning' / 'memory'`) as today. Only things promoted to the shared wiki become `type='knowledge'` objects. Clean separation between "what this agent remembers" and "what this workspace knows".

## Explicitly deferred — NOT in v1

Each of these is cheap to add later once v1 has earned it:

- **Curator / lint agent** (post-session trigger or weekly cron that proposes drafts, detects contradictions, flags stale articles). Build it once articles actually exist and we see how they drift. Until then you're building a janitor for an empty room.
- **Semantic search** (pgvector). Not needed below a few hundred articles per workspace.
- **Graph visualization page.** The `linked-objects` list on the detail page surfaces structure well enough for v1.
- **Notification-based draft approval flow.** Drafts are just `status='draft'` — visible in the list, editable, promotable by any member. No extra workflow needed.
- **Dedicated `capture_knowledge` / `search_knowledge` MCP helpers.** Only add if agents misuse the generic `create_objects` / `search_objects`.

## V1 implementation — days, not weeks

1. Register `knowledge` as a code-level extension at `extensions/knowledge/{server,web,shared}.ts` (mirrors the `work` extension), and import it in `apps/dev/src/extensions.ts` + `apps/web/src/lib/extensions.ts`. The extension declares the object type, fields, statuses, and relationship types above.
2. Enable the module per-workspace by adding `'knowledge'` to `settings.enabled_modules`. Runtime `create_extension` remains available as an alternative enablement path but is not used for the v1 ship.
3. Add `KNOWLEDGE_NUDGES` to `packages/shared/src/prompts.ts` and wire `apps/dev/src/services/agent-prompt.ts` to append it to `SYSTEM_PROMPT` at container launch whenever the workspace has `knowledge` enabled.
4. Add a "Knowledge" object-type tab in the web app's object list via `extensions/knowledge/web/index.ts` (`objectTypeTabs: [{ label: 'Knowledge', value: 'knowledge' }]`).

No schema migration, no new routes, no new MCP tools, no container image rebuild.

## Verification

1. `pnpm dev` up, MCP connected.
2. Enable the module on the development workspace (`PATCH /api/workspaces/:id` adding `'knowledge'` to `settings.enabled_modules`). Confirm via `get_workspace_schema` that `knowledge` is a valid object type in that workspace.
3. `create_objects({type:'knowledge', ...})` with the customer-tables article → confirm row exists via `GET /api/objects?type=knowledge`.
4. Web app → object list → "Knowledge" tab shows the article; open it → markdown renders, linked-objects panel shows any `informs`/`about`/`supersedes` edges.
5. Open a new session in that same workspace. Ask "which customer table should I use?" — verify the agent calls `search_objects({type:'knowledge', ...})`, then `get_objects`, then answers correctly citing the article id.
6. Second browser tab (different user) edits the article → confirm realtime update via SSE in the first tab and in any live session.
7. A session calls `create_objects` with a `supersedes` edge pointing at an older article → old article auto-greys in the list via `linked-objects` / status update.
8. Open a new session in a workspace **without** `knowledge` enabled → verify the system prompt does NOT contain `KNOWLEDGE_NUDGES` (opt-in hygiene).

## Resolved questions

- *"Does the default-actor system-prompt template live in one place, or is it per-actor?"* — per-actor (`actors.system_prompt`, stamped at actor creation by the templates in `packages/shared/src/templates/*`). Rather than spraying the nudge across every template, the session manager appends it at container launch — keeps existing actors up-to-date automatically and respects opt-in.
- *"Runtime `create_extension` now, code-level follow-up?"* — collapsed to code-level from day 1. Runtime `create_extension` still works for ad-hoc custom extensions, but `knowledge` is a first-class module.

## Sources

- [Karpathy's original tweet (Apr 2026)](https://x.com/karpathy/status/2039805659525644595)
- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Astro-Han/karpathy-llm-wiki — concrete raw/ + wiki/ + index.md pattern](https://github.com/Astro-Han/karpathy-llm-wiki)
- [LLM Wiki v2 — confidence, typed KG, multi-agent merge, contradiction hooks](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)
- [MindStudio explainer](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code)
