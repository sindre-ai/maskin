# Knowledge corpus lint — skill reference

Reference copy of the `knowledge-corpus-lint` workspace skill. The live SKILL.md is stored in the workspace-skills table (registered via `create_workspace_skill`); this file is the human-reviewable snapshot that lands on the bet PR alongside T1's `knowledge-format.md`. Keep the two in sync: when the live skill changes, update this file in the same PR.

The skill is the AC #3 gate for the parent bet [Three-layer knowledge — compiled articles + index so agents navigate instead of dumping context](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/9a589a23-4aaa-43c7-a872-a503efc91c1e). It scores the corpus against T1's `knowledge-format.md` (v1 frontmatter + compression test) and emits a machine-readable JSON artifact as a comment on the parent bet. When `severity_high.v1_subset == 0`, AC #3 is met.

## SKILL.md

```markdown
---
name: knowledge-corpus-lint
description: Use to lint the workspace knowledge corpus against the v1 frontmatter spec and the compression test. Runs on a daily cron, plus on demand when a human asks "is the knowledge corpus healthy?". Read-only — the linter reports, it does not repair. Detects five severity-high defect classes on `metadata.format_version = "v1"` articles (orphans, contradictions, stale `last_checked`, missing edges, compression-test failures) and emits a machine-readable JSON artifact as a comment on the parent bet. Non-v1 articles are scanned at severity-medium (informational only — the v1 pipeline is scoped to the format-layer bet). Do NOT use to write, edit, deprecate, or supersede knowledge (that's `knowledge-revision` / the Knowledge Author's write-side triggers). Do NOT use to score bet health or task hygiene (`bet-health`). This skill is the AC #3 gate for the three-layer knowledge bet — its artifact is what the parent bet is scored against.
---

# Knowledge Corpus Lint

The read-only skill that scores the knowledge corpus against the v1 frontmatter spec and the compression test. Complement — not overlap — of `knowledge-revision`: revision is *write-side* (freshness, dedup, supersede); this is *check-side* (defects, counts, artifact).

The contract: after every run, a machine-readable JSON block is posted on the parent bet whose `severity_high.v1_subset` counter can be checked without human interpretation. When that counter is `0`, AC #3 is met.

## When to invoke

- The daily cron trigger `Daily Knowledge Corpus Lint` (07:00 UTC).
- On demand when a human asks "is the knowledge corpus healthy?", "run the lint", or "did the T2 backfill land clean?".
- After any bulk write to knowledge (e.g. T2 completing) — the operator can nudge it early to confirm the v1 subset went to zero severity-high.

## Do NOT invoke

- To write, edit, deprecate, or supersede knowledge. This skill has read-only side effects: it calls `list_objects`, `search_objects`, `get_objects`, `list_relationships`, `create_comment`. It never calls `update_objects` on a knowledge row.
- To score bet-level health or task hygiene — that's `bet-health`.
- To measure the eval (T4/T5). This skill covers AC #3 only. The eval numbers live on a separate artifact per AC #4.
- To lint non-`knowledge` object types. The compression test is defined for the knowledge frontmatter; it does not apply to bets, insights, or tasks.

## Method

### 1. Load the v1 subset

`list_objects(type="knowledge", metadata_eq={"format_version": "v1"}, limit=100)` — paginate to exhaustion via `cursor` / `offset`. This is the acceptance-scoped subset. Also `list_objects(type="knowledge", limit=100)` and diff to get the non-v1 subset — those articles are scanned at `severity_medium`, non-blocking.

Record the subset counts up front:

- `v1_count` = N
- `non_v1_count` = N

### 2. Fetch each article with the fields the checks read

For each article in both subsets, `get_objects(ids=[...], include=["content","metadata","relationships"])`. Batch in groups of 50.

For every article the checks read exactly these fields:

- `metadata.format_version` — the version marker (v1 subset filter).
- `metadata.summary` — for the summary-length check (compression #1).
- `metadata.last_validated_at` (canonical name `updated`) — for the staleness check.
- `metadata.scope` — required in v1; missing = compression-test failure.
- `metadata.doc_type` (canonical name `type`) — required in v1.
- `metadata.tags` — required in v1; a `topic:*` tag must be present.
- `metadata.confidence` — required in v1.
- `content` — parsed for `https://maskin.io/<ws>/objects/<uuid>` references, PR shortlinks (`#\d+` in a code / prose position), and object titles bracketed as links. Each reference must be reachable via a `source_edges` relationship or the article fails compression-test #3.
- `relationships` — inbound + outbound edges. Outbound `derived_from | informs | about | supersedes | contradicts` = `source_edges`. Inbound `informs` from bets or insights is what saves an article from the orphan check.

### 3. Apply the checks

Run every check on every v1 article. The check → severity mapping is fixed; do not adjust per run. For each defect, record `{article_id, article_title, check, severity, why}`.

#### severity-high (v1 subset only; these are what AC #3 gates on)

**H1 — orphan.** The article has NO outbound `derived_from | informs | about | supersedes | contradicts` edge AND NO inbound `informs` from a bet or insight. Rationale: a knowledge article the corpus can't reach from any anchor is dead weight.

**H2 — contradiction unresolved.** The article has an outbound `contradicts` edge to another knowledge article, AND neither article is marked `supersedes` the other (in either direction) AND neither is `deprecated` / `archived`. Rationale: an unresolved live contradiction is a routing failure — the T5 router doesn't know which of the two to serve.

**H3 — stale `last_checked`.** `metadata.last_validated_at` is missing OR older than 90 days from today. Rationale: T1's `updated` field carries the freshness clock; 90 days is this skill's declared threshold since T1 didn't set a numeric one. Documented here so the check is deterministic across runs. A future revision of T1 can move the threshold; when it does, update this section and the check together.

**H4 — missing edge.** The body names a maskin object (URL pattern `https://maskin.io/<workspace_uuid>/objects/<uuid>`) that is NOT present as the target of any `source_edges` outbound edge. Rationale: compression-test check #3 verbatim — "every named object is edged". Do not flag GitHub PR shortlinks (`#123`) — the spec's `source_edges` are graph edges, not GitHub refs.

**H5 — compression-test failure.** Any one of the following trips it:

- `metadata.summary` missing or > 500 characters (check #1).
- Any required v1 field missing: `format_version`, `doc_type`, `summary`, `tags`, `confidence`, `last_validated_at`, `scope`. (Missing `scope` alone counts here — it's the newest v1 field and the most likely to be omitted in a backfill.)
- `tags` array present but contains no `topic:*` tag.
- Body length > 300 chars but zero `source_edges` outbound edges — heuristic for "orphan facts in the body" (check #2). Overlaps with H1 by design; both are recorded (a naked v1 article is broken on two axes, and the artifact should say so).

H4 and H5's overlap for "reference not edged" cases is intentional — the artifact records the article once per rule that trips, so a reviewer can see which of the three compression checks a given article fails.

#### severity-medium (informational; non-blocking for AC #3)

Same five checks re-run against the non-v1 subset, tagged `severity_medium` in the artifact. These reveal the size of the debt Stage 2+ will inherit but do not block T3's acceptance.

#### severity-low (informational)

- v1 article with `confidence: low` and `last_validated_at` older than 30 days (a low-confidence claim aging without re-check).
- v1 article whose `doc_type` is not in T1's enum (`topic_page | playbook | operational | profile | changelog | reference | note`).

### 4. Compile the artifact

The artifact is a single fenced JSON block inside a comment on the parent bet. The block's shape is fixed — a reviewer or a follow-up automation can regex `severity_high.v1_subset` out of it without an LLM.

    {
      "skill": "knowledge-corpus-lint",
      "skill_version": "1.0.0",
      "ran_at": "<ISO 8601 UTC>",
      "counts": {
        "v1_articles_scanned": 0,
        "non_v1_articles_scanned": 0
      },
      "severity_high": {
        "v1_subset": 0,
        "by_check": {
          "H1_orphan": 0,
          "H2_contradiction_unresolved": 0,
          "H3_stale_last_checked": 0,
          "H4_missing_edge": 0,
          "H5_compression_test_failure": 0
        },
        "defects": [
          { "article_id": "<uuid>", "article_title": "<string>", "check": "H3_stale_last_checked", "why": "last_validated_at 2026-01-14 is 181 days old (>90d threshold)" }
        ]
      },
      "severity_medium": {
        "non_v1_subset": 0,
        "by_check": { "M1_orphan": 0, "M2_contradiction_unresolved": 0, "M3_stale_last_checked": 0, "M4_missing_edge": 0, "M5_compression_test_failure": 0 },
        "defects_sample": []
      },
      "severity_low": {
        "count": 0,
        "defects_sample": []
      },
      "acceptance": {
        "ac_ref": "bet:9a589a23 AC #3",
        "gate": "severity_high.v1_subset == 0",
        "passed": true
      }
    }

Rules for the payload:

- `severity_high.defects` is exhaustive — every high-severity finding on the v1 subset must appear. This is what makes the gate mechanically checkable.
- `severity_medium.defects_sample` and `severity_low.defects_sample` are capped for comment size. Full lists live only in the run log; the counts are the durable signal.
- `acceptance.passed` is a redundant convenience field — `severity_high.v1_subset == 0` is the source of truth.
- Article titles must be included alongside IDs. Reviewers scan titles; the ID is the pointer.

Post it as a `create_comment` on the parent bet with a two-line human header above the fenced JSON:

> Corpus lint run — `2026-07-14T07:00Z`.
> v1 scanned: `<n>` — severity-high on v1 subset: `<n>` (`PASS` / `FAIL`).
> `<json block>`

### 5. Silence-vs-post policy

Always post. Even a clean run (`severity_high.v1_subset == 0`) posts the artifact — that IS the evidence AC #3 relies on. This is the opposite of `notification-hygiene`'s "silent on clean run" — for this skill, the clean-run artifact is the deliverable.

The one exception: if the v1 subset is empty (`v1_articles_scanned == 0`), still post the artifact with `severity_high.v1_subset: 0` and add a one-line note in the human header that T2 has not yet landed or the v1 tag hasn't been applied. This distinguishes "clean corpus" from "empty corpus" and prevents a false green.

### 6. Dedup

Do not post more than once per calendar day. Before posting, `get_comments(entity_id=<parent_bet>, limit=25)` — if a comment from this skill (identifiable by the fenced JSON's `"skill": "knowledge-corpus-lint"` marker) already exists with `ran_at` on today's date UTC, exit silently instead of double-posting. On-demand runs after the daily cron are allowed if a human explicitly requested one — the invoking comment / message is the audit trail.

## What NOT to do

- Do not call `update_objects` on any knowledge article. This skill is diagnostic; repair is out of scope (Stage 2+).
- Do not add or remove `source_edges` relationships to "fix" an H4 finding — that is a write, and it belongs on the Knowledge Author's write-side skills, not here.
- Do not skip the v1 subset count when it's zero. A zero-count artifact is still the artifact.
- Do not mix the v1 subset and the non-v1 subset in the `severity_high` block. AC #3 is scoped to v1; a non-v1 defect is severity-medium regardless of severity in isolation.
- Do not adjust the 90-day staleness threshold at runtime. If it needs to move, update this SKILL.md and the check together so past artifacts remain interpretable.
- Do not post a summary Slack message. In-product only. This skill exists to make AC #3 machine-checkable, not to page a human.
- Do not open PRs, create tasks, or spawn other sessions from this skill. Read-only, single-artifact-per-run.
```

## Trigger

- Name: `Daily Knowledge Corpus Lint`
- Type: cron
- Cadence: `0 7 * * *` (daily 07:00 UTC — one hour behind the workspace-coach daily observation so the corpus is quiet during the sweep).
- Target actor: Knowledge Author (topical fit — knowledge health belongs to the knowledge domain owner).
- Action prompt (one paragraph): load `knowledge-corpus-lint` via `get_workspace_skill` and run it in full. Post the artifact on the parent bet. In-product only — no Slack. Don't call `create_notification`.
