-- Rollback for 0113. Drops both proposal tables; pending proposals are lost, files are untouched.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "file_proposal_changes";
--> statement-breakpoint
DROP TABLE IF EXISTS "file_proposals";
