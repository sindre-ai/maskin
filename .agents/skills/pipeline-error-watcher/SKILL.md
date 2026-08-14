---
name: pipeline-error-watcher
description: Fires hourly to poll Sentry for new production errors, correlates each to the merging PR (SHA-first, file-path + 14-day recency fallback), and opens exactly one auto_bug bet per Sentry issue.id. Dedupes via metadata.sentry_issue_id. Bodies are observation-only per the Ronacher suppression checklist — no speculative RCA, no fabricated repro, no reasoning by analogy, no log dumps.
---

# Pipeline Error Watcher

Turn a fresh production error into exactly one `auto_bug` bet, correlated to the most likely merging PR, with a body a maintainer can read and act on without wading through speculation.

## When to run

Fires on the hourly cron trigger wired by T6 (`15 * * * *`). Never invoke directly outside that trigger — the trigger's metadata holds the `last_run` cursor this skill depends on, and a hand-fired run against a stale cursor will re-scan a large window unnecessarily.

If `SENTRY_AUTH_TOKEN` is unset, or any of the three Sentry project keys are missing, log a single error and exit. Do not create bets from a partial query.

The watcher is workspace-scoped — do not read a token from a different workspace's secret store. Multi-workspace OAuth pain is why a per-workspace token store exists in the first place.

## Prerequisites

The parent bet's `## Exit criteria` remain live: if >30% of opened `auto_bug` bets get dismissed as wrong correlation over the first two weeks, the heuristic must be re-shaped, not extended. The T1 backtest measured the file-path fallback path at 0% precision on the 30-day customer-reported bug set — so the SHA-first path is the workable one, and the fallback runs on borrowed time. When the guardrail trips, exit early on subsequent runs and alert via the `slack-writer` skill.

## Cursor

Read `last_run_iso` from the firing trigger's `metadata.last_run` (ISO-8601 UTC). If unset (first run), use `now - 1h`. After the run completes successfully, write `now.toISOString()` back to `metadata.last_run` on the trigger via `update_trigger`.

A missed hour just widens the next window — dedup (Step 3) absorbs any issues that would otherwise be double-picked. Cursor writes happen at the end of the run so a crashed run replays the same window on the next tick.

## Step 1 — Query Sentry

For each project in `["maskin-web", "maskin-api", "maskin-agent-runtime"]`:

```
GET https://sentry.io/api/0/projects/<org>/<project>/issues/?query=firstSeen:>{last_run_iso}
Authorization: Bearer $SENTRY_AUTH_TOKEN
```

Read `<org>` from `SENTRY_ORG` (provisioned by T2). Paginate via the `Link: rel="next"` header until exhausted. Collect `(project, issue)` tuples. Each `issue` carries `id`, `permalink`, `title`, `firstSeen`, `culprit`.

If the API returns a non-2xx, log the response body verbatim and exit. Do not fabricate an empty result — a silent zero-count run would advance the cursor past real issues.

## Step 2 — Correlate to the merging PR

For each issue, resolve one `correlated_pr_url` and one `correlation_method`.

### SHA-first (preferred)

Fetch the latest event: `GET /api/0/issues/<id>/events/latest/`. Read `release.commits[0].id` (populated once T4 wires release tagging on the deploy pipeline). If set:

- Search GitHub via the MCP `search_code`/`search_issues` surface: `<sha> is:pr is:merged` across `sindre-ai/maskin`, `sindre-ai/skjald`, and every `vaerksted-ai/*` repo the app is connected to.
- Take the single merged PR that owns the SHA. Set `correlation_method = "sha"`, `correlated_pr_url = <html_url>`.
- If the search returns zero results (unusual — happens for hotfix or force-push flows), fall through to the file-path path.

### File-path + 14-day recency (fallback)

When no SHA is present or the SHA search returned zero results:

1. Extract in-project stack frames from the event's `entries[type="exception"].data.values[].stacktrace.frames[]`. Keep only frames whose `filename` starts with a known repo prefix (`apps/`, `packages/`, `src/`). Drop `node_modules`, stdlib, and framework-internal frames.
2. If the resulting file set is empty, set `correlation_method = "none"`, `correlated_pr_url = null`, and skip to Step 3 — the body will note the missing signal.
3. Otherwise list merged PRs across `sindre-ai/maskin` + `sindre-ai/skjald` + every `vaerksted-ai/*` repo with `merged_at` in `[issue.firstSeen − 14d, issue.firstSeen]`. Fetch each candidate's changed-files list. Keep candidates whose changed files intersect the frame file set.
4. Rank surviving candidates by `merged_at` descending. Pick the most recent. Set `correlation_method = "file_path"`, `correlated_pr_url = <html_url>`.

This mirrors the join the T1 backtest ran; keep it identical so both bets share one correlation primitive.

## Step 3 — Dedup

Before creating anything, call `search_objects` filtered by `metadata_eq: { sentry_issue_id: <issue.id> }`.

- Any hit with a non-terminal status (anything other than `succeeded` / `failed` / `archived`): the issue is already tracked. Skip it silently. Do not comment, do not touch the existing bet.
- All hits terminal, or zero hits: fall through to Step 4.

Dedup runs before the create call, not as a database constraint — `sentry_issue_id` is a metadata field and only serves as an identity key for this skill.

## Step 4 — Open the auto_bug bet

Match the existing `auto_bug → fix → live` lane the workspace's `bug-triage` skill defines. `auto_bug` is a **bet with `metadata.auto_bug: true`**, not a distinct object type — do not invent one.

One `create_objects` call per new (or resurfaced) issue:

- **Bet** — type `bet`, status `active`, title `Fix: <sanitized issue.title>` (strip agent-internal jargon and cap at 80 chars). Driver: Workspace Driver (resolve via `list_actors` by role name; currently `d625cf31-fb6c-45df-a8c2-e2823d6053ae`). Metadata:
  - `auto_bug: true`
  - `sentry_issue_id: <issue.id>`
  - `sentry_url: <issue.permalink>`
  - `correlated_pr_url: <url or null>`
  - `correlation_method: "sha" | "file_path" | "none"`
  - `repo: "maskin"`
- **Task** — status `todo`, linked to the bet via `breaks_into`, same title. Driver: Developer (resolve via `list_actors` by role name; currently `212d2818-09df-4751-b8df-d0f1108ec0c1`). Body mirrors the bet body.

Then in a follow-up `update_objects` call, move the task to `in_progress`. This matches the actuation pattern in `bug-triage`: the driver stamp at birth + the explicit `todo → in_progress` step keep the Developer's actuation router firing without a watchdog bounce.

Setting the drivers at creation is non-negotiable — a driverless auto_bug bet in `active` never emits a `status_changed` event, so the ownership-stamp triggers never fire and the bet stalls until a liveness watchdog trips over it hours later.

## Body composition — observation-only

Bet and task body use exactly this template. No speculation, no analogy, no log dumps.

```
## Context
Production error first seen <issue.firstSeen>.
Sentry: <issue.permalink>

## Stack
<top 5 in-project stack frames, verbatim from the Sentry event>

## Correlation
Likely-cause PR: <correlated_pr_url> (matched by <method>).

If method is "file_path", precision is unvalidated — verify the PR
touches the failing code path before spending time on the fix.
If method is "none", no candidate PR was found — investigate from
the stack alone.

## Definition of Done
- Root cause identified from the stack + repo state.
- Fix landed in the correlated repo.
- Bet closes via the standard auto_bug → fix → live lane.

## Constraints
Follow standard bug-fix hygiene — no special constraints from the
watcher.

## Out of Scope
Anything the stack does not touch. Do not enlarge the surface.

## References
- Sentry: <issue.permalink>
- Correlated PR: <correlated_pr_url>
```

## Suppression checklist (binding — Ronacher's four failure modes)

Applied from [Ronacher's four failure modes give triage a smell-test for AI-generated bug reports](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/57a5db99-191a-49d6-97f9-ba3719ab1908). Any body that pattern-matches any of the four is invalid — regenerate from the template above.

1. **No speculative root-cause analysis presented as fact.** Do not write "This is probably caused by X" or "The issue looks like Y." Only observed facts: what Sentry captured, what the stack shows, what the correlation heuristic returned. Speculative RCA is the costliest of the four modes because it anchors the maintainer's investigation in the wrong place — suppress it hardest.
2. **No fabricated minimal reproduction.** Sentry did not give you a repro. Do not synthesize one. If you cannot copy the failing input from `issue.culprit` verbatim, write nothing under a repro heading.
3. **No suggested fixes based on incorrect analogies.** The correlated PR is a candidate for investigation, not a diagnosed match. Do not say "this looks like the bug fixed in <other PR>, apply <that fix>."
4. **No extensive lists of errors of dubious relevance.** Only the top 5 in-project stack frames go in the body. No additional logs, no lint output, no unrelated stack traces, no PostHog session context.

The positive template above ("first seen … stack … correlated PR by method") is observation-only by construction — sticking to it strips out three of the four modes automatically.

## Resurfacing

If Step 3 found only terminal-status hits for the `sentry_issue_id`, open a fresh bet — do NOT reopen a closed one. The prior bet's verdict is preserved as knowledge; the fresh bet gets its own lifecycle.

Add `resurfaced_from: <prior_bet_id>` to metadata and prepend one line to the bet body: `Resurfaced from <prior_bet_id> (closed <prior.status_at>).` Nothing else changes about the template.

## After the run

- Write the new cursor to `trigger.metadata.last_run` via `update_trigger`. Only on the success path — a failed run must not advance the cursor.
- If any Sentry or GitHub call failed with a non-2xx, alert via the `slack-writer` skill on the pipeline-health channel. Do not swallow the error — the trigger's exponential backoff needs a signal to back off on.

## What you never do

- Never open more than one bet per Sentry `issue.id`. Dedup runs before every create.
- Never open a bet with no `sentry_issue_id` — that field is the dedup key; without it, the next run duplicates the bet.
- Never invent a new object type. `auto_bug` is a `bet` with `metadata.auto_bug = true`, matching `bug-triage`.
- Never poll faster than hourly. Sentry free-tier quota is 5k events/mo and the T6 cadence is the ceiling.
- Never write speculative language into a bet body. Ronacher's four modes are the invalidation list, not a style suggestion.
- Never leak internal terms into human-facing text — no skill names, trigger names, step numbers, or internal field names in the bet or task body.
- Never advance the cursor after a failed run.

## Voice

Plain, observation-only. If a maintainer opens the bet and cannot tell whether an agent or a human filed it because it just states facts — the voice is right.
