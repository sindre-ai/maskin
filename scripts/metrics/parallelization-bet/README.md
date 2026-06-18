# Parallelization-bet metrics

Tracking for the bet *"Parallelize agent pipeline — remove human-in-the-loop merge gate"*.
This directory holds queryable SQL plus a small Node runner so anyone can pull the
seven metrics on demand and compare the two windows the bet defines.

| Window | Range | Meaning |
| --- | --- | --- |
| `baseline` | 2026-04-01 → 2026-04-26 | Pre-change |
| `treatment` | 2026-04-26 → 2026-05-17 | Three weeks post-change |

## Quick start

```bash
# Both windows side-by-side, with cap read from workspaces.settings:
node scripts/metrics/parallelization-bet/run.mjs --workspace <workspace_id>

# Just one window:
node scripts/metrics/parallelization-bet/run.mjs --workspace <workspace_id> --window baseline
node scripts/metrics/parallelization-bet/run.mjs --workspace <workspace_id> --window treatment

# Custom range (inclusive start, exclusive end):
node scripts/metrics/parallelization-bet/run.mjs \
  --workspace <workspace_id> \
  --start 2026-04-26T00:00:00Z --end 2026-05-03T00:00:00Z
```

`DATABASE_URL` is read from the env (or `.env` at the repo root). Same shape as the dev
backend uses.

`queries.sql` contains every metric as a standalone block (with a `-- name:` comment)
so they can be run individually with `psql` or pasted into a notebook.

## Metrics

### Primary

1. **Bet cycle time** — time from bet creation (proposed) to first transition
   into a terminal status (`completed` / `succeeded`). Reports median + average
   in hours over the window. Target: ≥30% drop in median.

2. **Average concurrent running sessions** — sampled at 5-minute intervals
   across Mon–Fri 09:00–17:00 UTC. Target: ≥2.0 (was ~1.0).

3. **% of work hours at concurrency cap** — share of the same samples where
   running sessions ≥ `max_concurrent_sessions`. Target: 10–30%. The runner
   reads the live cap from `workspaces.settings` unless `--cap` is passed.

### Secondary / health

4. **'Awaiting merge' notifications per bet** — heuristic match on
   `notifications.title`/`type` containing `merge`, `awaiting`, or `review`.
   Notifications attached to a task are attributed to that task's parent bet
   via the `breaks_into` edge. Target: ~1 per bet (down from ~1 per task).

5. **Task rework rate** — % of tasks created in the window that ever
   transitioned `done` → `in_progress`. Target: flat or lower vs baseline.
   Uses `events.action = 'status_changed'` with the `previous`/`updated`
   payload from `apps/dev/src/routes/objects.ts`.

6. **Edge coverage on new bets** — % of bets created in the window where at
   least one of their tasks has a `blocks` edge. Approximation; manual review
   of the first 3–4 newly planned bets is still required to verify prose
   dependencies are fully captured. Target: >90%.

7. **Daily Bet Sweep firings** — sessions in the window whose trigger name
   matches `bet sweep` / `daily bet`. Target: approach zero.

## Acceptance for this task

- ✅ Each metric is queryable on demand for either window — `queries.sql` is
  parameterized on `(workspace_id, start, end)` plus the cap for the
  concurrency query.
- ⏭️ Capture baseline values before May 17 — run the script with
  `--window baseline` and paste the output into the bet's content (or into the
  three-week wrap-up task) so the wrap-up has something to compare against.

## Notes

- The concurrency query uses a subquery-per-bucket pattern. ~1300 buckets
  across three weeks, so it's fine for ad-hoc reporting; not optimised for a
  live dashboard.
- The merge-notification heuristic is product-copy-sensitive. If the
  notification template wording changes, update the `ILIKE` list in
  `queries.sql` and `run.mjs`.
- Edge coverage is structural only. A bet with one `blocks` edge and twelve
  prose-only deps still counts as covered. Pair with manual review.
- All windows are evaluated in UTC.
