-- session_dispatch_attempts — Postgres-backed dispatch queue for session-start
-- calls from apps/dev to apps/agent-server. Absorbs backpressure when no
-- agent-server has capacity and retries failed dispatches with exponential
-- backoff. The same idempotency_key is reused across every retry of a given
-- session, so the receiver (and downstream side-effect layer per T10) dedupes
-- any double-fire.
--
-- Status lifecycle:
--   pending → (dispatched) → row deleted
--   pending → (exhausted attempts or permanent failure) → failed
--
-- One row per session_id — UNIQUE prevents two queued dispatches for the same
-- session. Re-enqueueing the same session is an UPSERT.

CREATE TABLE IF NOT EXISTS "session_dispatch_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer NOT NULL DEFAULT 0,
	"max_attempts" integer NOT NULL DEFAULT 5,
	"status" text NOT NULL DEFAULT 'pending',
	"next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

--> statement-breakpoint

ALTER TABLE "session_dispatch_attempts"
	ADD CONSTRAINT "session_dispatch_attempts_session_id_uniq" UNIQUE ("session_id");

--> statement-breakpoint

ALTER TABLE "session_dispatch_attempts"
	ADD CONSTRAINT "session_dispatch_attempts_status_check"
	CHECK ("status" IN ('pending', 'failed'));

--> statement-breakpoint

-- Worker claim path: WHERE status='pending' AND next_attempt_at <= now()
-- ORDER BY next_attempt_at LIMIT N FOR UPDATE SKIP LOCKED.
CREATE INDEX IF NOT EXISTS "session_dispatch_attempts_ready_idx"
	ON "session_dispatch_attempts" ("status", "next_attempt_at");
