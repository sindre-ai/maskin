# Knowledge article conventions

How to write good knowledge articles in the Knowledge extension. Both humans and agents follow these conventions — the Knowledge Curator (`extensions/knowledge/server/agents.ts`) is prompted to uphold them, and `KNOWLEDGE_NUDGES` in `packages/shared/src/prompts.ts` points every agent here.

## What belongs in a knowledge article

Durable, workspace-relevant truths. Examples:

- **Data-model facts**: "The canonical customer table is `analytics.dim_customers`. The `analytics.customers_raw` table is a staging table and should not be queried directly."
- **Tooling conventions**: "Always run `pnpm type-check` before opening a PR — CI runs it too but it's faster to catch locally."
- **Architectural decisions**: "We chose Drizzle over Prisma because we need raw-SQL escape hatches in ~8 places."
- **Non-obvious gotchas**: "PG NOTIFY payloads silently fail above 8KB — always truncate large fields in triggers."

Do not file:

- Per-session debug output or transient state.
- Information already covered by an existing article — update that article instead.
- Speculation. Only record things supported by source material you've read.

## Article shape

| Field | Required | Notes |
|---|---|---|
| `title` | yes | Short, specific, declarative. "Customer data: canonical table" not "notes about customers". |
| `content` | yes | Full markdown. Multi-paragraph is fine. Include code examples and cross-references. |
| `status` | yes | `draft` → `validated` → `deprecated`. See lifecycle below. |
| `metadata.summary` | yes | One sentence usable in listings. "Canonical customer table is `analytics.dim_customers`." |
| `metadata.confidence` | optional | `low` / `medium` / `high`. How sure are you? |
| `metadata.tags` | optional | Faceted browse. Comma-separated. |
| `metadata.last_validated_at` | optional | Set when a human (or the Curator's lint pass) re-confirms the article is still true. |

## Status lifecycle

```
draft → validated → deprecated
```

- **`draft`** — the default for agent-proposed articles. Visible in the list but flagged as provisional. Anyone can edit. The Knowledge Curator never promotes `draft` to `validated` — that's a human decision.
- **`validated`** — a human has confirmed the article is correct. Set `metadata.last_validated_at` to the promotion date. The weekly lint pass flags `validated` articles whose `last_validated_at` is older than 90 days.
- **`deprecated`** — the article is no longer correct. Usually set automatically when a `supersedes` edge is created. Keep the article around (do not delete) so history is preserved.

## Relationships

Three edge types are declared in `extensions/knowledge/shared.ts`:

- **`supersedes`** — new article replaces old. When you create one, set the older article's `status` to `deprecated`.
- **`contradicts`** — two articles disagree on the same subject. The edge is the flag; resolution is manual (or done by a later lint pass).
- **`about`** — a knowledge article is *about* a specific bet/task/insight. Lets an agent working on that object pull the relevant knowledge directly.

For provenance (which session/trigger produced the article), use the existing `informs` edge from the triggering object (bet/task/insight) to the new article.

## Rewrite, don't append

Karpathy's core insight in the [LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) is that knowledge compounds only when the article is *rewritten as a coherent whole*, not when new material is appended. When you have new information about a topic:

1. Search first. `search_objects({type:'knowledge', q:'<topic>'})`.
2. If a near-match exists, call `update_objects` on it and rewrite the `content` so the new information is woven in, not tacked on.
3. Only create a new article when no reasonable match exists.

The `KNOWLEDGE_NUDGES` prompt enforces this for agents. Humans should follow the same rule.

## When to use `supersedes` vs. edit-in-place

- **Edit in place** when the facts have drifted slightly and the core subject is unchanged. Example: table name was renamed; article still about "canonical customer table".
- **Supersede** when the subject itself has changed. Example: you had an article about the old "Warehouse v1" data model; you've now moved to "Warehouse v2" with different tables and different semantics. The two should coexist with a `supersedes` edge so the history stays readable.

## Sensitive content

Do not paste credentials, tokens, or PII into knowledge articles. The current extension has no automatic redaction — the content field is visible to every workspace member. If a session log contained credentials, the Curator is instructed to skip that material rather than capture it.
