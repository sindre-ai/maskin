-- Daily and weekly active human users, from the Maskin database. Read-only.
-- See docs/runbooks/daily-active-human-users.md for what this does and does not count.
--
-- Run against a read replica or in a read-only transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY' -f docs/runbooks/daily-active-human-users.sql
-- Change the window by editing the two numbers in the "params" CTE (days back, default 30).
--
-- Columns per UTC day:
--   signups  human actors created that day
--   dau      distinct human actors with at least one event that day
--   wau      distinct human actors with at least one event in the 7 UTC days ending that day
-- Today's row is partial until 00:00 UTC.

WITH params AS (
  SELECT (now() AT TIME ZONE 'UTC')::date AS to_day,
         (now() AT TIME ZONE 'UTC')::date - 29 AS from_day
),
days AS (
  SELECT generate_series(p.from_day, p.to_day, interval '1 day')::date AS day
  FROM params p
),
humans AS (
  SELECT id, created_at
  FROM actors
  WHERE type = 'human' AND is_system = false
),
active AS (
  -- One row per human per UTC day. Looks back 6 extra days so the first wau is complete.
  SELECT DISTINCT e.actor_id, (e.created_at AT TIME ZONE 'UTC')::date AS day
  FROM events e
  JOIN humans h ON h.id = e.actor_id
  CROSS JOIN params p
  WHERE e.created_at >= ((p.from_day - 6)::timestamp AT TIME ZONE 'UTC')
    AND e.created_at < ((p.to_day + 1)::timestamp AT TIME ZONE 'UTC')
)
SELECT d.day,
       (SELECT count(*) FROM humans h
         WHERE (h.created_at AT TIME ZONE 'UTC')::date = d.day) AS signups,
       (SELECT count(*) FROM active a WHERE a.day = d.day) AS dau,
       (SELECT count(DISTINCT a.actor_id) FROM active a
         WHERE a.day BETWEEN d.day - 6 AND d.day) AS wau
FROM days d
ORDER BY d.day;

-- Comparison variant for the PostHog check: the same dau, but only events from workspaces
-- that share usage and do not anonymise (the ones whose app_active reaches PostHog under the
-- person's own id). Replace the "active" CTE above with this one and re-run.
--
-- active AS (
--   SELECT DISTINCT e.actor_id, (e.created_at AT TIME ZONE 'UTC')::date AS day
--   FROM events e
--   JOIN humans h ON h.id = e.actor_id
--   JOIN workspaces w ON w.id = e.workspace_id
--   CROSS JOIN params p
--   WHERE e.created_at >= ((p.from_day - 6)::timestamp AT TIME ZONE 'UTC')
--     AND e.created_at < ((p.to_day + 1)::timestamp AT TIME ZONE 'UTC')
--     AND coalesce(w.settings -> 'privacy' ->> 'share_usage', 'true') <> 'false'
--     AND coalesce(w.settings -> 'privacy' ->> 'anonymize_workspace', 'false') <> 'true'
-- )
