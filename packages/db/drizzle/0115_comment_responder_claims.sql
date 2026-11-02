-- One responder session per (comment event, actor).
--
-- Two independent paths can each start an interactive session for the same actor on the same
-- comment: the thread-reply auto-spawn (routes/events.ts, runs in the POST /events/comments
-- request) and the CommentDispatcher fallback ladder (services/trigger-runner.ts, runs off the
-- PG NOTIFY bridge). They start within ~50ms of each other, so a read-then-write check cannot
-- tell them apart. Each path now INSERTs a claim row first and only the INSERT that wins starts a
-- session; the loser stands down. The primary key is the guarantee.
--
-- New, empty, low-volume table (one row per dispatched responder), not on the hot-tables list, so
-- plain DDL is fine. Row-level security is switched on because 0111_enable_rls_public_tables ran
-- before this table existed.
-- Down: drizzle/down/0115_comment_responder_claims_down.sql.

CREATE TABLE IF NOT EXISTS "comment_responder_claims" (
	"source_comment_event_id" bigint NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"claimed_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "comment_responder_claims_pk" PRIMARY KEY ("source_comment_event_id", "actor_id"),
	CONSTRAINT "comment_responder_claims_claimed_by_enum" CHECK ("claimed_by" IN ('thread_reply', 'comment_fallback'))
);
--> statement-breakpoint
ALTER TABLE "comment_responder_claims" ENABLE ROW LEVEL SECURITY;
