-- Expression index on coalesce(completed_at, updated_at) — a session's
-- "settled" time (paused rows leave completed_at null and settle at updated_at).
--
-- The reconciler's §9.4 self-heal pass (services/session-reconciler.ts) selects
-- terminal sessions in a settled-at window with no events row, ordered by that
-- same expression. Nothing indexed it, so each pass scanned every session row
-- (~122k, ~460MB) and anti-joined events for each — mean 4.6s, max 113s, which
-- also evicts the buffer cache the rest of the app depends on. The query now
-- bounds the window and orders by this exact expression, so it becomes an
-- ascending range scan that stops at its LIMIT.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_settled_at_idx"
	ON "sessions" ((coalesce("completed_at", "updated_at")));
