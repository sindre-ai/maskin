-- The "was this card already sent?" check before a notification card is written
-- (apps/dev/src/services/self-start-limits.ts, run-death-alerts.ts, daily-budget-card-scheduler.ts):
--   FROM events WHERE workspace_id = $1 AND entity_type = 'notification' AND action = 'created'
--     AND data->'metadata'->>'source' = $2 AND data->'metadata'->>'dedupe_key' = $3 ... LIMIT 1
-- No index covers the two JSON fields, so each check read every notification event of the
-- workspace: 23.6k calls on production, 817 ms on average, 23.8 s at worst.
--
-- Partial on the two literals the checks always carry, so it holds one entry per notification
-- card created. Keyed on source then dedupe_key; the daily-budget and run-death checks name only
-- source plus a bounded created_at window and still use the first two columns.
--
-- `events` is written on every mutation, so the build is CONCURRENTLY and alone in its file
-- (see packages/db/MIGRATIONS.md Rule 1). Down: drizzle/down/0172_events_notification_dedupe_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "events_notification_dedupe_idx"
  ON "events" USING btree (
    "workspace_id",
    ("data" -> 'metadata' ->> 'source'),
    ("data" -> 'metadata' ->> 'dedupe_key')
  )
  WHERE "entity_type" = 'notification' AND "action" = 'created';
