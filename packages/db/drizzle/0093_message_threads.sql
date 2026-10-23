-- Migration: message threads.
--
-- A reply inside a thread points at its root message via messages.thread_root_id.
-- Roots are never replies (one level), so the pointer never chains. thread_also_in_channel
-- marks a reply the author also posted to the main timeline. Both columns are additive and
-- default to the pre-thread meaning, so existing readers and rows are unaffected.
--
-- message_thread_reads holds each actor's advance-only read cursor per thread.
--
-- Idempotent: all objects use IF NOT EXISTS so re-running is safe.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "thread_root_id" bigint REFERENCES "messages"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "thread_also_in_channel" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_root_idx" ON "messages" USING btree ("thread_root_id", "id") WHERE "thread_root_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_thread_reads" (
  "actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
  "root_message_id" bigint NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "last_read_message_id" bigint NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("actor_id", "root_message_id")
);
