-- Tracks who owns a conversation's title so the background auto-titler
-- (apps/dev/src/services/conversation-titler.ts) knows whether it may write:
--   'none'    — never auto-titled; generate from the first message
--   'initial' — titled once; eligible for one refinement once the thread has
--               enough context (see REFINE_AT_MESSAGES)
--   'refined' — final auto title; never regenerate
--   'manual'  — a human renamed it via PATCH /conversations/:id; never touch
-- The titler transitions this column with a conditional UPDATE before it calls
-- the LLM, which is what makes it safe to fire from every message post without
-- a lock.
--
-- conversations is not on the hot-tables list (MIGRATIONS.md) and adding a
-- NOT NULL column with a constant DEFAULT is metadata-only on PG 11+, so no
-- chunked backfill is needed. Existing rows land on 'none' and pick up a
-- generated title on their next message, which is the desired behaviour.
ALTER TABLE "conversations" ADD COLUMN "title_auto_state" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_title_auto_state_check"
	CHECK ("title_auto_state" IN ('none', 'initial', 'refined', 'manual'));
