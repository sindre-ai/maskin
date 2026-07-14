# Knowledge format — v1

Reference spec for `knowledge`-type objects in the Maskin corpus. This is the shape T2 backfills to, T3 lints, T4 measures against, and T5 routes on. Version-marked by `metadata.format_version = "v1"`.

Field names below are canonical — do not rename. Storage columns are shown for T2/T3/T5, but authors and reviewers speak in the canonical names.

## Frontmatter fields

| Field | Storage | Type | Required | Semantics |
|-------|---------|------|----------|-----------|
| `id` | row `id` | uuid | required | The object's UUID. Stable primary key; used as the `target_id` of `source_edges` from other articles. |
| `type` | `metadata.doc_type` | enum | required | One of `topic_page`, `playbook`, `operational`, `profile`, `changelog`, `reference`, `note`. Author-set. T5 routes on this. |
| `summary` | `metadata.summary` | string, ≤500 chars | required | Single compressed paragraph that answers the question the article exists to answer. Must satisfy the compression test below. |
| `tags` | `metadata.tags` | string[] | required | `key:value` retrieval tokens. At minimum one `topic:*`. Conventional keys: `topic:*`, `theme:*`, `provenance:*`, `source:*`. |
| `source_edges` | `relationships` | edge[] | required if the body references any other object; empty permitted otherwise | Graph edges the article depends on. Allowed types: `derived_from`, `informs`, `about`, `supersedes`, `contradicts`. Every proper noun / bet / PR / article named in the body must be reachable through one of these edges. |
| `confidence` | `metadata.confidence` | enum | required | `low` \| `medium` \| `high`. Author-set at write time; promoted only by additional independent evidence. |
| `updated` | `metadata.last_validated_at` | date (ISO 8601, `YYYY-MM-DD`) | required | The date the article's claims were last verified true. Distinct from the row's `updated_at` (that's automatic and moves on any edit — this one only moves when a human or agent re-checks the claim). |
| `scope` | `metadata.scope` | enum | required | Where the claim applies. One of `workspace`, `product-area`, `org`, `universal`. Bounds re-use across workspaces and repos. New in v1. |
| `format_version` | `metadata.format_version` | literal `"v1"` | required | The machine-readable version marker. T2, T3, and T5 filter the corpus on `metadata.format_version = "v1"` — a row without it is v0 and out of scope for the new pipeline. |

## The compression test

An article passes the compression test iff **all three** checks hold. T3's lint applies the same three checks mechanically; a human reviewer applies them by reading.

1. **Summary is self-contained.** Reading `summary` alone answers the question the article exists to answer, at the resolution an agent needs to act on it. Length ≤500 characters.
2. **Body carries no orphan facts.** Every load-bearing fact in the body is either restated in `summary` or reachable via a `source_edges` link. The body explains mechanism and evidence; it does not smuggle in new claims a summary-only reader would need.
3. **Every reference is edged.** Every bet, insight, PR, article, or other object named in the body has a corresponding `source_edges` entry pointing to it. No dangling references.

Failing any one check fails the test.

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

## Notes

- The frontmatter is machine-readable YAML on-disk (for docs and prototypes) and equivalent JSONB on the `objects.metadata` column (for the live corpus). T5's router reads whichever form is native to the surface.
- v1 is intentionally small. Fields that don't earn their place in the compression test are not in v1 — add them in a versioned successor if evidence demands.
- Out of scope for this spec: writing/editing knowledge objects (T2), lint implementation (T3), baseline harness (T4), index/router logic (T5), and Stage 2+ concerns (ingest pipeline, memory engine, embedding hybrid search).
