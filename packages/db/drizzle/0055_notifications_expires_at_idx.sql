-- Partial index on `notifications(expires_at)` for the expiry sweep loop (T4).
-- The sweep polls for `expires_at <= now() AND status IN ('pending','seen')`
-- and applies `default_action` (or drops the card) when the deadline is hit;
-- the partial predicate matches that read exactly — resolved/expired rows
-- never make it into the index, so scan cost stays flat.
--
-- `notifications` isn't on the hot-tables list in packages/db/MIGRATIONS.md
-- (only `webhook_deliveries` is), so CONCURRENTLY isn't strictly required to
-- protect a webhook. We use it anyway because the sweep will churn the table
-- on a 60s loop once T4 lands and we want to avoid holding a SHARE lock on
-- `notifications` for the initial build in production.
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: kept as
-- the only statement in this file so no future edit can wrap it in a BEGIN
-- and silently leave an INVALID index behind. `IF NOT EXISTS` makes a retry
-- safe if a previous CONCURRENTLY build was interrupted.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_expires_at_idx"
	ON "notifications" ("expires_at")
	WHERE "expires_at" IS NOT NULL AND "status" IN ('pending', 'seen');
