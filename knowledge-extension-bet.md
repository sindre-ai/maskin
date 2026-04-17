# Bet: Knowledge Extension — self-improving workspace wiki for humans + agents

**One-liner:** Ship a Maskin extension that turns mid-session corrections ("don't use `analytics.customers_raw`, use `dim_customers`") into durable, shared, workspace-scoped knowledge articles that both humans browse like a wiki and agents retrieve on demand. Pattern: Karpathy's "LLM Wiki" (Apr 2026), mapped onto primitives Maskin already has.

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
    { type: "informs", source_type: "session", source_id: "<session-id>", target_type: "object", target_id: "<new-article-id>" },
  ],
})
```

Humans writing knowledge use the **existing** object detail page (`apps/web/src/components/objects/object-document.tsx`) — already renders markdown, supports inline edit, shows linked objects. The extension adds `knowledge` as a type tab the same way `work` adds "Bets".

## Read path — agent searches on demand

The agent retrieves knowledge the way Karpathy's pattern intends: it **reads the wiki**, rather than having it pre-loaded.

**Mechanism:** one line in each agent's default system prompt:

> "Before answering domain questions or making assumptions about data, schemas, or tooling, call `search_objects({type:'knowledge', q:'<terms>'})`. If relevant titles come back, call `get_objects({id})` to read the full article."

That's it. No CLAUDE.md injection, no workspace context hook, no `agent-run.sh` edit. Reasons:

- **Karpathy's own point:** the agent should *read* the wiki on demand, not have it shoved in at boot. The whole value of the pattern is that the agent treats knowledge like a folder it grep/cats.
- **Staleness:** a pre-stuffed index goes stale the moment another user edits an article mid-session. On-demand search is always fresh.
- **Token economy:** in a workspace with 200 articles, maybe 3 matter for a given task. Pre-injecting 200 titles wastes 197 of them.
- **Simpler system:** no session-manager change, no env-var plumbing, no container-side file generation.

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

1. Call `create_extension` with the payload above against the development workspace.
2. Add one line ("search knowledge before answering domain questions…") to the default actor system prompt template (this might be a single row update in the `actors` table, or a config in the onboarding template — one-line change either way).
3. Add a "Knowledge" object-type tab in the web app's object list. If the `work` extension already demonstrates the pattern (it does, in `extensions/work/web/index.ts`), this is also essentially a declaration.

That's it. No backend deploy, no migration, no container image rebuild.

## Verification

1. `pnpm dev` up, MCP connected.
2. `create_extension` call (above) — confirm via `list_extensions` that `knowledge` now appears enabled in the workspace.
3. `create_objects({type:'knowledge', ...})` with the customer-tables article → confirm row exists via `GET /api/objects?type=knowledge`.
4. Web app → object list → "Knowledge" tab shows the article; open it → markdown renders, linked-objects panel shows any `informs`/`about`/`supersedes` edges.
5. Open a new session in the same workspace with the updated system prompt. Ask "which customer table should I use?" — verify the agent calls `search_objects({type:'knowledge', ...})`, then `get_objects`, then answers correctly citing the article id.
6. Second browser tab (different user) edits the article → confirm realtime update via SSE in the first tab and in any live session.
7. A session calls `create_objects` with a `supersedes` edge pointing at an older article → old article auto-greys in the list via `linked-objects` / status update.

## Open questions

- Does the default-actor system-prompt template live in one place, or is it per-actor? (Need to grep for where `SYSTEM_PROMPT` is seeded so the "search knowledge first" nudge lands consistently for new agents.)
- Do we want the extension to also ship for all *future* workspaces automatically (register as code in `extensions/knowledge/` following the `extensions/work/` pattern), or is runtime-per-workspace enough for v1? Recommendation: do the runtime call now to unblock; fold it into a code-level extension in a follow-up PR once the shape is settled.

## Sources

- [Karpathy's original tweet (Apr 2026)](https://x.com/karpathy/status/2039805659525644595)
- [Karpathy's llm-wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- [Astro-Han/karpathy-llm-wiki — concrete raw/ + wiki/ + index.md pattern](https://github.com/Astro-Han/karpathy-llm-wiki)
- [LLM Wiki v2 — confidence, typed KG, multi-agent merge, contradiction hooks](https://gist.github.com/rohitg00/2067ab416f7bbe447c1977edaaa681e2)
- [MindStudio explainer](https://www.mindstudio.ai/blog/andrej-karpathy-llm-wiki-knowledge-base-claude-code)
