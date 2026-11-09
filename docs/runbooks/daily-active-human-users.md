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

## Tolerance

Judgment from one day with very small numbers, not a guarantee. 2026-11-08 was a Sunday.

- The database dau should be equal to or higher than app_active, and by no more than 2 people
  while daily counts stay under about 10. Database below app_active by more than 1 person means
  something is wrong (a filter, a missing actor type, or a broken heartbeat), so investigate.
- Once daily counts pass about 10, switch to a relative check: database within -10% and +50% of
  app_active.
- Re-check the tolerance after a week of daily samples, since one Sunday can be unrepresentative.
- Direction differs by design (see above), so a read-only-heavy day can push app_active above the
  database. That is why the lower bound is not zero.

## Verification status

Checked against production for UTC 2026-11-08: the main query and the comparison variant both ran
in a read-only transaction and returned dau 4, wau 12, signups 1. PostHog showed 2 distinct people
with app_active that day. The numbers were produced twice, independently, and agree.

Matched by actor id, both PostHog people are among the 4 database people, and PostHog has no one
the database lacks. Of the 2 database-only people, one wrote 18 updates spread across the whole day
and never sent app_active, which fits non-browser use. The other signed up at 19:09 UTC, wrote 3
events within seconds and sent no app_active that day. The database cannot say which client wrote
the events, so the first is plausible and the second is not proven: if new sign-ups regularly show
no heartbeat on their first day, that is a gap in the heartbeat, not a reason to distrust the
database count. Watch for it during the week of daily samples.
