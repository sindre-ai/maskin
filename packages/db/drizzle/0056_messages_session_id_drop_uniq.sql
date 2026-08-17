-- messages is one migration old (0051_conversations.sql) with negligible row
-- count, so plain (non-CONCURRENTLY) DDL is fine here, unlike the sessions
-- changes above. Dropping the unique constraint because an interactive
-- session is now long-lived and reused across many replies in the same
-- conversation (see conversation-responder.ts) — one session legitimately
-- produces many message rows now, where before it was capped at one message
-- per one-shot session.
ALTER TABLE "messages" DROP CONSTRAINT "messages_session_id_uniq";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_session_id_idx" ON "messages" ("session_id");
