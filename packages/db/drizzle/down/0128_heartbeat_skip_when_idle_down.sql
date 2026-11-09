-- Rollback for 0128. Removes skip_when_idle from every default Heartbeat, so they fire daily again
-- whether or not anyone used the workspace. It also removes the setting from Heartbeats that were
-- created with it after #2865, because the two cannot be told apart.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "triggers"
SET "config" = "config" - 'skip_when_idle',
	"updated_at" = now()
WHERE "name" = 'Heartbeat'
	AND "type" = 'cron'
	AND "metadata" ? 'default_heartbeat'
	AND "config" ? 'skip_when_idle';
