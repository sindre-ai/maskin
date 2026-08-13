-- Partial index on `notifications(dispatch_at)` for the deferred-wake reaper
-- loop (T4). The reaper polls for `dispatch_at <= now() AND wake_dispatched
-- = false` and then dispatches the wake to the paused source session; the
-- partial predicate keeps the index tight — only unclaimed pending rows sit
-- in it, so scan cost stays flat as historical notifications accumulate.
--
-- `notifications` isn't on the hot-tables list in packages/db/MIGRATIONS.md
-- (only `webhook_deliveries` is), so CONCURRENTLY isn't strictly required to
-- protect a webhook. We use it anyway because the reaper will churn the
-- table on a 60s loop once T4 lands and we want to avoid holding a SHARE
-- lock on `notifications` for the initial build in production.
--
-- `CREATE INDEX CONCURRENTLY` per packages/db/MIGRATIONS.md Rule 1: kept as
-- the only statement in this file so no future edit can wrap it in a BEGIN
-- and silently leave an INVALID index behind. `IF NOT EXISTS` makes a retry
-- safe if a previous CONCURRENTLY build was interrupted.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_dispatch_at_pending_idx"
	ON "notifications" ("dispatch_at")
	WHERE "dispatch_at" IS NOT NULL AND "wake_dispatched" = false;
