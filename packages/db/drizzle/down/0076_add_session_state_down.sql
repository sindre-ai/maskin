-- Rollback for 0076_add_session_state.sql. Drops the two partial indexes,
-- the CHECK, the two self-FKs, and the seven added columns. Same discipline
-- as 0074_graph_conversation_session_types_down.sql — lives under
-- drizzle/down/ so the forward migration runner never picks it up. Invoked
-- explicitly by the reversibility check in the accompanying integration test.
--
-- Reverting this migration REQUIRES first reverting Commits 5, 6, and 7 —
-- they read/write these columns. Running this against a database that still
-- has Commit 5/6/7 code deployed is unsafe.

DROP INDEX IF EXISTS "sessions_retry_at_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "sessions_session_state_state_entered_at_idx";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_retry_of_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_retried_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_session_state_check";
--> statement-breakpoint
ALTER TABLE "sessions"
	DROP COLUMN IF EXISTS "driver_heartbeat_at",
	DROP COLUMN IF EXISTS "attempt_number",
	DROP COLUMN IF EXISTS "retry_of",
	DROP COLUMN IF EXISTS "retried_session_id",
	DROP COLUMN IF EXISTS "retry_at",
	DROP COLUMN IF EXISTS "state_entered_at",
	DROP COLUMN IF EXISTS "session_state";
