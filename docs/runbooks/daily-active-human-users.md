# Daily and weekly active human users, from our own database

The north-star count must not depend on PostHog, because new workspaces start with usage sharing
off and PostHog will undercount from now on. The query is in
[daily-active-human-users.sql](./daily-active-human-users.sql). It is read-only.

## What it returns

One row per UTC day, default the last 30 days:

| Column | Meaning |
|---|---|
| day | UTC calendar day. Today's row is partial. |
| signups | Human actors created that day (actors table, type human). |
| dau | Distinct human actors with at least one event that day. |
| wau | Distinct human actors with at least one event in the 7 UTC days ending that day. |

"Human" means actors.type = 'human' and actors.is_system = false. Agents and system actors are
excluded. Everyone else is included, so our own team counts too (the database has no team flag;
PostHog's is_team is computed at send time).

## What it does not count

**Read-only visits are not counted.** The events table records writes (create, update, comment,
status change). Nothing in the database records a login or a visit that only reads. A person who
opened the app and changed nothing is missed, so dau and wau are a floor.

If the north star must count visits, add one small last-active stamp on the human actor, written
by the server on authenticated requests, at most once per UTC day. That is a separate task and a
schema change, not part of this one.

## How to run it

Run it against a read replica, or inside a read-only transaction:

    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY' -f docs/runbooks/daily-active-human-users.sql

Cost: the only index on events is by workspace and time, so the cross-workspace range scan reads
every event in the window. Fine for one run a day. If it is run more often or over a long window,
add an index on created_at first.

## Comparing with PostHog

The PostHog daily-active heartbeat is the web event app_active, sent once per browser per UTC day
after sign-in. It only reaches PostHog for workspaces that share usage and do not anonymise. The
sql file ends with a commented variant of the query that applies the same filter. Expect the
database number to differ from app_active in both directions: app_active counts read-only visitors
(database misses them), while the database also counts writes from the phone app and other
non-browser clients (app_active misses them). Anonymised workspaces cannot be matched person by
person.

## Sample-day comparison (2026-11-08, UTC)

Run on production by Infra & DevOps on 2026-11-09. Database numbers are read-only selects.

| Measure | Count |
|---|---|
| Database dau, all workspaces | 4 |
| Database dau, shared-usage and non-anonymised workspaces only (the comparison variant) | 4 |
| PostHog app_active, distinct actors (all web, all flagged is_team) | 2 |
| Database wau (7 days ending that day) | 12 |
| Database signups that day | 1 |

Both PostHog actors were also in the database set. The two extra database humans had writes only
(updates and one create) and sent no web heartbeat that day, so the gap came from people acting
without a browser heartbeat, not from the filter.

## Week of samples (2026-11-09 to 2026-11-15, UTC)

Run on production by Infra & DevOps on 2026-11-16, read-only selects on both sides. Database is
the comparison variant (shared-usage, non-anonymised workspaces); it equalled the all-workspaces
dau on every day. PostHog is distinct actor_id on app_active. DB-only and PH-only count people
present in one source and absent from the other, matched by actor id.

| Day | Weekday | Database dau | PostHog app_active | Database minus PostHog | DB-only | PH-only |
|---|---|---|---|---|---|---|
| 2026-11-09 | Mon | 6 | 4 | +2 | 2 | 0 |
| 2026-11-10 | Tue | 5 | 4 | +1 | 2 | 1 |
| 2026-11-11 | Wed | 3 | 3 | 0 | 1 | 1 |
| 2026-11-12 | Thu | 3 | 2 | +1 | 1 | 0 |
| 2026-11-13 | Fri | 4 | 4 | 0 | 2 | 2 |
| 2026-11-14 | Sat | 3 | 3 | 0 | 1 | 1 |
| 2026-11-15 | Sun | 3 | 2 | +1 | 1 | 0 |

Totals: database 27, PostHog 22. The difference was 0 to +2 on every day, never negative, average
+0.7. The ratio database to PostHog ran from 1.0 to 1.5. No day reached 10 people, so the
relative check below is still untested.

What the gaps were made of: one person is database-only on all seven days (writes with no browser
heartbeat). PostHog-only people appeared on 4 of 7 days (read-only visitors), and were always
covered by at least as many database-only people, which is why the net difference never went
below 0.

For context, the same queries on 2026-11-02 to 2026-11-08 gave differences of +1, +1, +1, 0, -1,
+3 and +2. These days are not part of the seven used for the bound: 2026-11-06 was 1 below (two
PostHog people without writes) and 2026-11-07 was 3 above (a sign-up day with three database-only
people).

## Tolerance

Set on 2026-11-16 from the seven days 2026-11-09 to 2026-11-15 above. Numbers are still very small
(2 to 6 people a day), so this is a judgment, not a guarantee.

- The database dau should be equal to or higher than app_active, and by no more than 2 people
  while daily counts stay under about 10. The seven days sat between 0 and +2.
- Database below app_active by 1 person: compare by actor id before accepting it. This was seen
  once (2026-11-06) and was two read-only visitors, so it is a check, not an incident.
- Database below app_active by 2 or more people means something is wrong (a filter, a missing
  actor type, or a broken heartbeat), so investigate. Before this check the line was "more than 1
  below".
- Database more than 2 above app_active (seen once, +3 on 2026-11-07, a sign-up day) is worth a
  look at whether new sign-ups are sending the heartbeat (see below).
- Once daily counts pass about 10, switch to a relative check: database within -10% and +50% of
  app_active. Unchanged, because no sampled day reached 10.
- Direction differs by design (see above), so a read-only-heavy day can push app_active above the
  database. That is why the lower bound is not a strict zero.
- Re-check again when daily counts regularly pass 10, or when a new client starts sending the
  heartbeat.

## Verification status

Checked against production for UTC 2026-11-08: the main query and the comparison variant both ran
in a read-only transaction and returned dau 4, wau 12, signups 1. PostHog showed 2 distinct people
with app_active that day. The same numbers came out of two separate runs.

Matched by actor id, both PostHog people are among the 4 database people, and PostHog has no one
the database lacks. Of the 2 database-only people, one wrote 18 updates spread across the whole day
and never sent app_active, which fits non-browser use. The other signed up at 19:09 UTC, wrote 3
events within seconds and sent no app_active that day. The database cannot say which client wrote
the events, so the first is plausible and the second is not proven: if new sign-ups regularly show
no heartbeat on their first day, that is a gap in the heartbeat, not a reason to distrust the
database count. Watch for it during the week of daily samples.

Result of that watch (checked 2026-11-16): five humans signed up from 2026-11-03 to 2026-11-15.
Two sent app_active on their sign-up day (11-03 and 11-06). Three never sent it at all through
2026-11-15 (sign-ups on 11-07, 11-08 and 11-13). Their workspaces had sharing on and were not
anonymised, so the comparison filter does not explain it, and each wrote only 3 to 8 events in a
workspace created the same day. The cause is not established: it could be non-browser use or a
heartbeat that is not sent for new sign-ups. The database count is not affected.
