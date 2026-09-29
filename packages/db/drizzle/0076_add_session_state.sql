-- Migration: add session_state lifecycle columns to sessions + partial indexes + back-fill
--
-- Adds the seven columns from the session-lifecycle bet's tech spec §15.2:
--   session_state, state_entered_at, retry_at, retried_session_id, retry_of,
--   attempt_number, driver_heartbeat_at.
--
-- Adds two partial indexes so the reaper (session_state + state_entered_at)
-- and the retry-scheduler (retry_at) each scan a tiny fraction of live rows.
--
-- Back-fills session_state + state_entered_at for every pre-existing row so
-- Commits 5/6/7 can read the new columns without a NULL-guard branch. Rows
-- with status='pending' or 'queued' map to session_state='queued'; rows with
-- status='starting' or 'running' keep their state; status='snapshotting'
-- collapses into 'running' (tech spec §22); every other terminal status maps
-- to 'done'. New rows written after this migration lands take the DEFAULT
-- 'queued' automatically.
--
-- Deploy order: this migration runs BEFORE the code that reads or writes
-- session_state (Commits 5/6/7). App-only rollback is safe — pre-Commit-5
-- code ignores the new columns. Migration revert requires code revert first
-- because dropping session_state under running Commit-5 code would break
-- every session write.
--
-- Killswitch for retry behaviour is a code-safe env var owned by Commit 7:
-- setting FEATURE_RETRY_SCHEDULER=0 disables the retry-scheduler's 30s tick
-- without touching this migration.
--
-- Idempotent — safe to re-run.

ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "session_state" text NOT NULL DEFAULT 'queued'
		CHECK ("session_state" IN ('queued','waiting_for_machine','starting','running','done')),
	ADD COLUMN IF NOT EXISTS "state_entered_at" timestamptz NOT NULL DEFAULT NOW(),
	ADD COLUMN IF NOT EXISTS "retry_at" timestamptz NULL,
	ADD COLUMN IF NOT EXISTS "retried_session_id" uuid NULL REFERENCES "sessions"("id"),
	ADD COLUMN IF NOT EXISTS "retry_of" uuid NULL REFERENCES "sessions"("id"),
	ADD COLUMN IF NOT EXISTS "attempt_number" integer NOT NULL DEFAULT 1,
	ADD COLUMN IF NOT EXISTS "driver_heartbeat_at" timestamptz NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sessions_session_state_state_entered_at_idx"
	ON "sessions" ("session_state", "state_entered_at")
	WHERE "session_state" IN ('starting','running','waiting_for_machine');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sessions_retry_at_idx"
	ON "sessions" ("retry_at")
	WHERE "retry_at" IS NOT NULL AND "retried_session_id" IS NULL;
--> statement-breakpoint

UPDATE "sessions" SET "session_state" = CASE "status"
		WHEN 'pending' THEN 'queued'
		WHEN 'queued' THEN 'queued'
		WHEN 'starting' THEN 'starting'
		WHEN 'running' THEN 'running'
		WHEN 'snapshotting' THEN 'running'
		ELSE 'done'
	END,
	"state_entered_at" = COALESCE("started_at", "updated_at", NOW());
