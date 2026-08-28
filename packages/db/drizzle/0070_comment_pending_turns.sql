-- Comments that arrive while an agent's interactive comment-thread session is
-- still booting (pending/starting/queued) are buffered here by
-- routeCommentToAgent instead of being dropped, then drained via writeInput
-- once the session's stdin attaches — see
-- SessionManager.drainPendingCommentTurns. Comment-thread analogue of
-- conversation_pending_turns (0062).
--
-- thread_root_event_id / comment_event_id carry no FK to "events" for the same
-- reason as sessions.comment_thread_root_event_id (0067).
CREATE TABLE IF NOT EXISTS "comment_pending_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"thread_root_event_id" bigint NOT NULL,
	"actor_id" uuid NOT NULL,
	"comment_event_id" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_pending_turns" ADD CONSTRAINT "comment_pending_turns_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Idempotency: one buffered turn per (thread root, agent, comment) — doubles
-- as the (thread root, agent) drain-lookup index. Plain (non-CONCURRENT)
-- index is fine: the table is brand new and empty.
CREATE UNIQUE INDEX IF NOT EXISTS "comment_pending_turns_root_actor_comment_uniq"
	ON "comment_pending_turns" ("thread_root_event_id", "actor_id", "comment_event_id");
