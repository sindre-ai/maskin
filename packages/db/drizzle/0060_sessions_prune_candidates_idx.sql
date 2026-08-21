-- Backs the session-log retention sweep, which selects completed
-- non-interactive sessions whose logs are past the cutoff. Interactive
-- sessions are excluded from the index entirely — their logs are retained
-- permanently so chat conversations keep their full trace.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_prune_candidates_idx"
	ON "sessions" USING btree ("completed_at")
	WHERE "interactive" = false AND "completed_at" IS NOT NULL;
