# Knowledge format — v1

Reference spec for `knowledge`-type objects in the Maskin corpus. This is the shape T2 backfills to, T3 lints, T4 measures against, and T5 routes on. Version-marked by `metadata.format_version = "v1"`.

Field names below are canonical — do not rename. Storage columns are shown for T2/T3/T5, but authors and reviewers speak in the canonical names.

## Three layers

The format organises the corpus into three layers, in the spirit of Karpathy's LLM-wiki pattern (raw sources → compiled wiki → schema/index). Each layer maps onto our existing node/edge substrate — no new `object.type` values, no new edge types, no row-schema changes.

| Layer | What it is | Node representation | Owner | Mutability |
|-------|-----------|---------------------|-------|------------|
| **Layer 1 — Raw captures** | Untouched source records: bet retros, insights, tasks, uploaded files, meetings, external evidence. The provenance the article layer compiles from. | Whatever `object.type` the record already is (`bet`, `insight`, `task`, `file`, `meeting`, external). No new type, no `knowledge` subtype. | Whoever created the original record. | Immutable from the format layer's perspective — the format never rewrites raw records. |
| **Layer 2 — Compiled articles** | Single-topic Markdown articles that synthesise across raw captures and pass the compression test. | `object.type = "knowledge"` with `metadata.doc_type` in {`topic_page`, `playbook`, `operational`, `profile`, `changelog`, `reference`, `note`} + full v1 article frontmatter (below). | Knowledge Author (writes/edits). | LLM-owned — rewritten as evidence changes; superseded articles closed with a `supersedes` edge, not deleted. |
| **Layer 3 — Index / router nodes** | Lightweight catalogs that name what articles exist in a domain, so the router reads the index first and pulls only the articles it needs. | `object.type = "knowledge"` with `metadata.doc_type = "index"` + index-layer frontmatter (below). | Knowledge Author (or the future write-side ingest op). | Regenerable — the catalog is materialised from its `derived_from` edges to articles; a lint pass reconciles drift with `covers`. |

**Read path.** Router picks a Layer-3 index whose `covers` matches the query domain → reads that index's summary and the summaries of its catalogued articles → pulls only the article bodies it decides it needs. Raw captures are followed via `derived_from` edges only when an article's provenance needs to be inspected.

**Write path.** A new raw capture triggers an article write/edit. Ingesting a new article into a domain triggers an index update (add the `derived_from` edge, rewrite the index's `summary` if the article count / topic mix shifted). Neither operation is implemented in this spec — T9 authors articles by hand for the pilot; T10 wires the read side; write-side automation is Phase 2.

## Article-layer frontmatter

| Field | Storage | Type | Required | Semantics |
|-------|---------|------|----------|-----------|
| `id` | row `id` | uuid | required | The object's UUID. Stable primary key; used as the `target_id` of `source_edges` from other articles. |
| `type` | `metadata.doc_type` | enum | required | One of `topic_page`, `playbook`, `operational`, `profile`, `changelog`, `reference`, `note`. Author-set. T5 routes on this. Index nodes use the separate `index` value (see index-layer frontmatter). |
| `summary` | `metadata.summary` | string, ≤500 chars | required | Single compressed paragraph that answers the question the article exists to answer. Must satisfy the compression test below. |
| `tags` | `metadata.tags` | string[] | required | `key:value` retrieval tokens. At minimum one `topic:*`. Conventional keys: `topic:*`, `theme:*`, `provenance:*`, `source:*`. |
| `source_edges` | `relationships` | edge[] | required if the body references any other object; empty permitted otherwise | Graph edges the article depends on. Allowed types: `derived_from`, `informs`, `about`, `supersedes`, `contradicts`. Every proper noun / bet / PR / article named in the body must be reachable through one of these edges. |
| `confidence` | `metadata.confidence` | enum | required | `low` \| `medium` \| `high`. Author-set at write time; promoted only by additional independent evidence. |
| `updated` | `metadata.last_validated_at` | date (ISO 8601, `YYYY-MM-DD`) | required | The date the article's claims were last verified true. Distinct from the row's `updated_at` (that's automatic and moves on any edit — this one only moves when a human or agent re-checks the claim). |
| `scope` | `metadata.scope` | enum | required | Where the claim applies. One of `workspace`, `product-area`, `org`, `universal`. Bounds re-use across workspaces and repos. New in v1. |
| `format_version` | `metadata.format_version` | literal `"v1"` | required | The machine-readable version marker. T2, T3, and T5 filter the corpus on `metadata.format_version = "v1"` — a row without it is v0 and out of scope for the new pipeline. |

## Index-layer frontmatter

Layer-3 index nodes carry a superset of the article-layer fields, with two differences: `type` is fixed to `"index"`, and `covers` replaces the free-form provenance role of `source_edges`. The `derived_from` edges still exist — they name the actual catalogued articles.

| Field | Storage | Type | Required | Semantics |
|-------|---------|------|----------|-----------|
| `id` | row `id` | uuid | required | The index node's UUID. |
| `type` | `metadata.doc_type` | literal `"index"` | required | Marks a Layer-3 index. T5's router reads this: rows with `doc_type == "index"` are routing targets (read first); rows with any other `doc_type` value are content targets (read on demand). New enum value in v1. |
| `summary` | `metadata.summary` | string, ≤500 chars | required | One paragraph naming the domain the index covers, at the resolution the router uses to decide whether to enter this index. Same self-contained rule as the article layer. |
| `tags` | `metadata.tags` | string[] | required | Retrieval tokens. At minimum one `topic:*` that matches (or spans) the domain named in `covers`. Conventional to also carry `index:<kind>` (e.g. `index:operational`) for humans skim-reading. |
| `covers` | `metadata.covers` | object | required | The selection rule that defines membership. Two supported forms: `{tag: "topic:xxx", doc_type: [...]}` (filter — all v1 articles matching the tag and optional doc_type list) or `{ids: [uuid, ...]}` (explicit — a fixed list of articles). New in v1. |
| `source_edges` | `relationships` | edge[] | required, non-empty | One `derived_from` edge from the index to each catalogued article. The edges are the source of truth for membership; `covers` is the human-readable rule the lint reconciles against. |
| `confidence` | `metadata.confidence` | enum | required | Same enum as the article layer. Usually `high` for a curated index. |
| `updated` | `metadata.last_validated_at` | date (ISO 8601) | required | The date the index was last reconciled with its catalogued articles. |
| `scope` | `metadata.scope` | enum | required | Same enum as the article layer. Bounds where the index is reusable. |
| `format_version` | `metadata.format_version` | literal `"v1"` | required | Same marker as the article layer. Router filters on it. |

The index carries its catalog as `derived_from` edges plus `covers`, never as an inline `entries` array. Rationale in "Design decisions".

## Edges between layers

Both layer transitions reuse the existing `derived_from` edge type. Direction and endpoint object types disambiguate the two semantics — the router does not need a new edge label.

| Edge | Direction | Meaning | How the router / lint distinguishes it |
|------|-----------|---------|---------------------------------------|
| Article → Raw | Article's `source_edges` point at bets, insights, files, meetings, tasks, external evidence via `derived_from`. | "This article's claims are compiled from these raw captures." | Source is `type=knowledge` with `doc_type` in the article enum; target is any non-knowledge object type (or a knowledge row without `format_version=v1`). |
| Index → Article | Index's `source_edges` point at each catalogued article via `derived_from`. | "This index catalogs these articles." | Both source and target are `type=knowledge` with `format_version=v1`; source has `doc_type=index`, target has `doc_type` in the article enum. |

`informs` remains available for cross-article relationships (article A informs the reasoning in article B). It is not used for the two layer transitions above.

## Design decisions

The format layer stays on the metadata surface: no new `object.type` values, no new edge types, no changes to the row schema. Every mapping question below was evaluated against that constraint and against T5's router (already shipped in [PR #1086](https://github.com/sindre-ai/maskin/pull/1086)), which filters on `metadata.format_version = "v1"` and reads `metadata.doc_type`.

**Raw capture representation — decided by Magnus 2026-07-15.** Raw captures stay as whatever `object.type` they already are (`bet`, `insight`, `task`, `file`, `meeting`, external attachment). No new `object.type = "raw"`; no `knowledge` subtype like `doc_type=raw`.

- *Considered:* introducing a `doc_type=raw` marker to make raw captures machine-detectable as a group.
- *Rejected:* the article layer's `source_edges` already point at raw captures via `derived_from` — the graph tells the router what's raw from context. A new marker would force back-labelling ~1,000 existing objects for no read-path win.

**Index layer representation — new `metadata.doc_type = "index"` on `object.type = "knowledge"`.**

- *Option A — new `object.type = "index"`.* Cleanest ontological separation. **Rejected:** schema change; forces T5's router to be re-plumbed across two tables; violates the same "keep the format layer thin" principle Magnus applied to the raw layer.
- *Option B — distinguish by a `tags: ["index"]` marker only.* No enum extension. **Rejected:** tags are retrieval tokens, not schema markers; router filters become fragile (string-tag matching); lint cannot structurally tell an index from an article.
- *Chosen — `metadata.doc_type = "index"`.* No schema change, extends the existing `doc_type` enum by one value, T5's router already reads `doc_type` so the change is a new filter branch rather than a new surface.

**Edge types — reuse `derived_from` for both layer transitions — decided by Magnus 2026-07-15.**

- *Considered:* adding new edge types like `catalogs` (index → article) and `compiled_from` (article → raw).
- *Rejected:* direction + endpoint object types already disambiguate the two semantics. New types burden every writer and reader; the value would be labelling clarity, not routing capability the router doesn't already have.

**Index membership — edges are the source of truth; `covers` is the rule.**

- *Considered:* inline `entries: [{id, summary, tags}]` array in the index's frontmatter. **Rejected:** violates the "every reference is edged" compression rule; the entries drift from the source articles' `summary` field on every article edit.
- *Chosen:* index has `covers` (the membership rule, human-readable and machine-executable) plus a `derived_from` edge to each catalogued article. The router materialises the catalog at read time by joining edges → target articles' `summary`. Lint verifies edges match `covers`.

## The compression test

An article passes the compression test iff **all three** checks hold. T3's lint applies the same three checks mechanically; a human reviewer applies them by reading.

1. **Summary is self-contained.** Reading `summary` alone answers the question the article exists to answer, at the resolution an agent needs to act on it. Length ≤500 characters.
2. **Body carries no orphan facts.** Every load-bearing fact in the body is either restated in `summary` or reachable via a `source_edges` link. The body explains mechanism and evidence; it does not smuggle in new claims a summary-only reader would need.
3. **Every reference is edged.** Every bet, insight, PR, article, or other object named in the body has a corresponding `source_edges` entry pointing to it. No dangling references.

Failing any one check fails the test.

**Index nodes take a modified test:** (1) `summary` names the domain the index covers, self-contained, ≤500 chars; (2) the index carries no free-authored body of catalog entries — the catalog is the set of `derived_from` targets, materialised at read time; (3) every catalogued article is reachable via a `derived_from` edge from the index **and** matches the `covers` rule (lint fails if `covers` and the edge set diverge).

### Worked example — passes

```yaml
id: c17369cf-bdea-46f6-a44c-862efbd0b620
type: operational
summary: "GitHub App installation tokens have a ~1h TTL. Sessions that mint once at start hit 401 on any git-write attempted >50 min later — push, merge-via-API, review-approve. First diagnostic move on late-run 401: check token-mint → write delta and installation-ID stability before credentials."
tags: ["topic:integrations", "topic:agent-architecture", "provenance:writer", "source:bet-retro"]
source_edges:
  - type: derived_from
    target_id: 3c5bb133-d2a9-4ae0-a26b-1486cc792fde  # source bet
confidence: low
updated: 2026-07-13
scope: product-area
format_version: "v1"
```

Body carries: the token TTL mechanism, the install-ID rotation angle, and the 3-step diagnostic — all restated at agent-usable resolution in `summary`. Sole named object (the source bet) is present in `source_edges`. Passes all three checks.

### Worked example — fails

```yaml
id: 8d9c6ef8-b8f6-48f8-b849-a86fd50cae10
type: operational
summary: "Sometimes bets close without evidence. Freeze scope at merge."
tags: ["topic:bet-lifecycle"]
source_edges: []
confidence: medium
updated: 2026-07-13
scope: workspace
format_version: "v1"
```

Body names PR #835, PR #847, PR #842, the Signup capture bet, the Default agent team bet, and the pre-commitment-waiver playbook. Fails all three checks:

1. **Summary not self-contained** — omits the mechanism (waiver → live-measurement dependency → post-merge accretion stretches the tail → shippable piece drifts to a sibling bet). A summary-only reader cannot apply the rule.
2. **Body carries orphan facts** — the specific PRs, the sibling bet identities, and the waiver-playbook pointer are load-bearing but appear neither in `summary` nor in `source_edges`.
3. **References not edged** — every named bet, article, and PR is missing from `source_edges`.

To pass: expand `summary` to name the mechanism and outcome, and add `derived_from` / `informs` edges to the source bet, the sibling article, and the pre-commitment waiver playbook.

## Worked example — three layers connected

Illustrates a raw capture (Layer 1), the article compiled from it (Layer 2), and an index that catalogs the article (Layer 3). All UUIDs are illustrative except `c17369cf-…` and `3c5bb133-…`, which reuse the example above so the article, its raw source, and its index entry cohere across the doc.

### Layer 1 — raw capture (existing `bet` object, untouched)

```yaml
# object.type = "bet" — a raw capture. No v1 frontmatter added.
id: 3c5bb133-d2a9-4ae0-a26b-1486cc792fde
title: "GitHub App tokens expire mid-session — agents 401 on late-run pushes"
type: bet
status: closed
metadata:
  verdict: failed_learning
  # no format_version, no doc_type — the format layer never rewrites raw records
```

### Layer 2 — compiled article (`type=knowledge`, `doc_type=operational`)

```yaml
id: c17369cf-bdea-46f6-a44c-862efbd0b620
type: operational
summary: "GitHub App installation tokens have a ~1h TTL. Sessions that mint once at start hit 401 on any git-write attempted >50 min later — push, merge-via-API, review-approve. First diagnostic move on late-run 401: check token-mint → write delta and installation-ID stability before credentials."
tags: ["topic:integrations", "topic:agent-pipeline", "provenance:writer", "source:bet-retro"]
source_edges:
  - type: derived_from
    target_id: 3c5bb133-d2a9-4ae0-a26b-1486cc792fde  # Layer 1 raw bet, above
confidence: low
updated: 2026-07-13
scope: product-area
format_version: "v1"
```

### Layer 3 — index (`type=knowledge`, `doc_type=index`)

```yaml
id: 4b1e2a70-9d54-4d1c-9c1a-6ab9f4c8d001
type: index
summary: "Catalog of operational knowledge for the agent pipeline: token/credential handling, session-scoped rate limits, retry policies, and diagnostic playbooks. Router entrypoint for topic:agent-pipeline operational queries. 6 articles currently indexed."
tags: ["topic:agent-pipeline", "index:operational"]
covers:
  tag: "topic:agent-pipeline"
  doc_type: ["operational", "playbook"]
source_edges:
  - type: derived_from
    target_id: c17369cf-bdea-46f6-a44c-862efbd0b620  # Layer 2 article, above
  - type: derived_from
    target_id: 5b2c9e11-3f14-4b02-a7d3-0f9a12b34c02  # + one derived_from per other catalogued article
  - type: derived_from
    target_id: e6a7d3f4-8b21-45c9-a1e0-7cb2d5f80003
  # ... six total
confidence: high
updated: 2026-07-15
scope: workspace
format_version: "v1"
```

### The graph, and how the router reads it

```
index 4b1e2a70   ──derived_from──▶   article c17369cf   ──derived_from──▶   bet 3c5bb133
(Layer 3, doc_type=index)             (Layer 2, doc_type=operational)         (Layer 1, type=bet)

Router flow for query "why are agents 401ing on late pushes":
1. search_objects(doc_type="index", tag="topic:agent-pipeline") → hits index 4b1e2a70.
2. Read the index's summary + follow derived_from edges + read each target article's summary.
   (~6 summaries × ~200 tokens ≈ 1.2k tokens)
3. Pick article c17369cf as most relevant; read its full body (~400 tokens).
4. If provenance is needed, follow c17369cf's derived_from to bet 3c5bb133; else stop.
```

Contrast the dump-into-context baseline: read all articles in the pilot domain (~60 rows × ~400 tokens ≈ 24k tokens) plus the raw bet body. The three-layer path spends ~1.6k tokens for the same answer — the ballpark the parent bet's Success line targets.

## Notes

- Frontmatter is machine-readable YAML on-disk (docs and prototypes) and equivalent JSONB on the `objects.metadata` column (live corpus). T5's router reads whichever form is native to the surface.
- v1 is intentionally small. Fields that don't earn their place in the compression test are not in v1 — add them in a versioned successor if evidence demands.
- Out of scope for this spec: writing/editing knowledge objects (T9 authors the pilot; corpus-wide backfill is Phase 2), extending T3's lint to the index-layer modified test (mechanical follow-up), extending T5's router to route on `doc_type=index` (T10), and Stage 2+ concerns (ingest pipeline, memory engine, embedding hybrid search).
