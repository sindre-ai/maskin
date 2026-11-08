-- Log retention sweep: the work list index (2 of 2, the column is 0134).
--
-- The sweep reads "finished non-interactive sessions not yet cleaned, oldest first, completed before
-- the 30 day cutoff". This partial index holds exactly those sessions, in that order, so each slice is
-- a short range scan. A session drops out of the index when the sweep sets logs_pruned_at, so once the
-- backlog is worked through the index holds only sessions finished in the last 30 days.
--
-- Write cost: a non-interactive session enters the index when it completes and leaves it when the
-- sweep marks it. Session start and stop for interactive sessions are untouched (excluded by the
-- predicate). The existing sessions_prune_candidates_idx stays: lifecycle-push-scheduler uses it.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). IF NOT EXISTS lets a retry pass after an interrupted
-- build; drop an INVALID leftover first.
-- Needs 0134. Down: drizzle/down/0135_sessions_logs_unpruned_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_logs_unpruned_idx"
  ON "sessions" USING btree ("completed_at")
  WHERE "interactive" = false AND "completed_at" IS NOT NULL AND "logs_pruned_at" IS NULL;
