-- Hot table: session_logs is written synchronously inside the Docker log-stream
-- loop and the agent-server reconcile request. CONCURRENTLY per MIGRATIONS.md Rule 1.
--
-- Every hot read filters on session_id and ranges/orders on id: the logs list
-- route's `since` (id > ?) and `before` (id < ?) cursors, and the turn
-- finalizer's backward walk for the nearest maskin_message_id envelope. The
-- existing (session_id, created_at) index cannot serve that ordering, so those
-- queries sort on top of it today.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_logs_session_id_id_idx"
	ON "session_logs" USING btree ("session_id","id");
