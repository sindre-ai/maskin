-- Migration: emoji reactions on chat messages.
--
-- One row per (message, actor, emoji). Rows go with the message or the actor.
-- Idempotent: IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS "message_reactions" (
  "message_id" bigint NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("message_id", "actor_id", "emoji")
);
