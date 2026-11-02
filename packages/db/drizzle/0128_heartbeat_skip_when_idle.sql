-- One-off data update: turn on skip_when_idle for the default Heartbeats that already exist.
--
-- The default Heartbeat (#2430) was backfilled to every agent on 23 Oct before skip_when_idle
-- existed (#2865), so none of the existing ones carry it and each fires daily in workspaces nobody
-- has touched for months. #2865 only turns the guard on for Heartbeats created after it, and the
-- backfill never rewrites a schedule, so a re-run would not fix them either.
--
-- Only default Heartbeats are touched: name 'Heartbeat', type cron, and the default_heartbeat
-- metadata key that tells them from a hand-made trigger with the same name. A config that already
-- has skip_when_idle (true or false) is left as it is. Nothing else in config changes, and enabled
-- and the schedule stay put. About 844 rows in production.
--
-- The trigger runner loads cron triggers from the table on boot and migrations run before the app
-- starts (apps/dev/Dockerfile), so the new setting is read on the first boot after this deploy.
-- triggers is not on the hot-tables list in MIGRATIONS.md and this is a bounded UPDATE, so the
-- unchunked statement is deliberate. Nothing fires on UPDATE of triggers.
-- Down: drizzle/down/0128_heartbeat_skip_when_idle_down.sql.
UPDATE "triggers"
SET "config" = "config" || '{"skip_when_idle": true}'::jsonb,
	"updated_at" = now()
WHERE "name" = 'Heartbeat'
	AND "type" = 'cron'
	AND "metadata" ? 'default_heartbeat'
	AND NOT ("config" ? 'skip_when_idle');
