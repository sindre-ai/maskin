-- Index for the session watchdog's status lookups on sessions (no workspace_id in the filter).
--
-- Once a minute the watchdog (SessionManager, 60 s tick) asks the table four questions that name a
-- status but no workspace: archive-paused (status = 'paused' and updated_at older than 7 days),
-- heal-running (status = 'running' with session_state still queued or starting), drain-queue
-- (status queued or pending, grouped by workspace) and the queued-for-capacity count (status =
-- 'queued'). The only status index, sessions_ws_status_idx, starts with workspace_id, so none of
-- them can use it and each reads the whole table. The clean-up query was seen taking 11 to 20 s.
--
-- This is a partial index over the four statuses those lookups ask for. Finished sessions are the
-- bulk of the table and are left out, so the index holds only the few live and paused rows and each
-- lookup reads only those. The planner uses it when the query's status condition lies inside the
-- list below, which is true of all four.
--
-- Not measured: this was written without access to production, so the claim that these four are the
-- slow ones rests on reading the queries. Check with EXPLAIN ANALYZE after deploy (see the PR).
--
-- sessions is not on the hot-tables list in packages/db/MIGRATIONS.md, but it is written on every
-- session start and stop, so the index is built CONCURRENTLY anyway, alone in its file, with IF NOT
-- EXISTS so a retry after a failed build works (Rule 1).
--
-- Reversible: drizzle/down/0134_sessions_open_status_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_open_status_idx"
	ON "sessions" ("status", "updated_at")
	WHERE "status" IN ('pending', 'queued', 'running', 'paused');
