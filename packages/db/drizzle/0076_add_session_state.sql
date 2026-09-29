-- Add session_state column + retry columns to sessions, and back-fill
-- pre-existing rows from the ambiguous `status` text.
--
-- Why (spec §15.1): `sessions.status` is a plain-text column with no enum and
-- an overloaded 'starting' bucket that covers both container-launching and
-- dispatcher-claimed-but-no-handshake. The reaper reads status+updatedAt and
-- can't distinguish waiting-on-machine from a genuine stall, so it declares
-- queued rows failed. The four state-machine columns below are the source of
-- truth for the redesigned reaper (Commit 6) and the retry-scheduler (Commit 7).
--
-- Column-order note: `NOT NULL DEFAULT` on the two required text/timestamp
-- columns means every NEW row is already valid the moment they land — the
-- inline UPDATE below only rewrites pre-existing rows to derive their state
-- from the current `status`. On PG 11+ a constant NOT NULL DEFAULT
-- ('queued', 1) is metadata-only. `state_entered_at DEFAULT NOW()` is
-- volatile and does rewrite once, which is acceptable at this workspace's row
-- count; `sessions` is not on the hot-tables list in packages/db/MIGRATIONS.md.
--
-- Deploy sequence: this migration MUST land BEFORE the Commit 5/6/7 code
-- deploy. Application-only rollback of that code is safe because pre-Commit-5
-- code ignores the new columns. Reverting THIS migration requires reverting
-- the code first.
--
-- Killswitch: the retry-scheduler introduced by Commit 7 reads
-- FEATURE_RETRY_SCHEDULER (env, apps/dev). Setting it to 0 disables the
-- retry loop with no code revert, no migration revert — the columns
-- themselves are inert without a writer.

ALTER TABLE "sessions"
	ADD COLUMN IF NOT EXISTS "session_state" text NOT NULL DEFAULT 'queued',
	ADD COLUMN IF NOT EXISTS "state_entered_at" timestamptz NOT NULL DEFAULT NOW(),
	ADD COLUMN IF NOT EXISTS "retry_at" timestamptz,
	ADD COLUMN IF NOT EXISTS "retried_session_id" uuid,
	ADD COLUMN IF NOT EXISTS "retry_of" uuid,
	ADD COLUMN IF NOT EXISTS "attempt_number" integer NOT NULL DEFAULT 1,
	ADD COLUMN IF NOT EXISTS "driver_heartbeat_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_session_state_check";
--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_session_state_check"
	CHECK ("session_state" IN ('queued','waiting_for_machine','starting','running','done'));
--> statement-breakpoint

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_retried_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_retried_session_id_sessions_id_fk"
	FOREIGN KEY ("retried_session_id") REFERENCES "sessions"("id");
--> statement-breakpoint

ALTER TABLE "sessions" DROP CONSTRAINT IF EXISTS "sessions_retry_of_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_retry_of_sessions_id_fk"
	FOREIGN KEY ("retry_of") REFERENCES "sessions"("id");
--> statement-breakpoint

-- Partial index for the reaper's live-session scan (Commit 6). Excludes
-- 'queued' + 'done' so the index only carries rows the reaper cares about —
-- a tiny fraction of all sessions once the historical tail is included.
CREATE INDEX IF NOT EXISTS "sessions_session_state_state_entered_at_idx"
	ON "sessions" ("session_state", "state_entered_at")
	WHERE "session_state" IN ('starting','running','waiting_for_machine');
--> statement-breakpoint

-- Partial index for the retry-scheduler's 30s tick (Commit 7). Excludes rows
-- already retried (`retried_session_id` set) so the scheduler picks each
-- retry_at at most once.
CREATE INDEX IF NOT EXISTS "sessions_retry_at_idx"
	ON "sessions" ("retry_at")
	WHERE "retry_at" IS NOT NULL AND "retried_session_id" IS NULL;
--> statement-breakpoint

-- Back-fill pre-existing rows (spec §15.2 / §22): derive session_state from
-- the ambiguous status text. Old 'starting' zombies stay 'starting' and are
-- reaped by Commit 6's 5-min BOOT_STALL_MS. Old 'queued' unable-to-get-machine
-- rows stay 'queued' and are rescued by Commit 6's driver-heartbeat check,
-- which flips them to 'waiting_for_machine' when capacity confirms no free
-- slot — the primary bug fix, no more false failures.
UPDATE "sessions" SET
	"session_state" = CASE "status"
		WHEN 'pending' THEN 'queued'
		WHEN 'queued' THEN 'queued'
		WHEN 'starting' THEN 'starting'
		WHEN 'running' THEN 'running'
		WHEN 'snapshotting' THEN 'running'
		ELSE 'done'
	END,
	"state_entered_at" = COALESCE("started_at", "updated_at", NOW());
