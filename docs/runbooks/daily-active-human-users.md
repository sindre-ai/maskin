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

## Verification status

Not yet run against production and not yet compared with PostHog. See the task and PR notes for the
sample-day comparison and the tolerance, once someone with database and PostHog read access has run
it.
