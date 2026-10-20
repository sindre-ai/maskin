-- Migration: decision cards in chat.
--
-- The card sits in messages.metadata.decision; this row holds who it is for, how urgent it is
-- and whether anyone has answered. Rows go with their message.
-- Idempotent: IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS "message_decisions" (
  "message_id" bigint PRIMARY KEY REFERENCES "messages"("id") ON DELETE CASCADE,
  "for_actor_ids" uuid[] NOT NULL,
  "attention" smallint,
  "status" text NOT NULL DEFAULT 'open',
  "answer_option_index" smallint,
  "answered_by" uuid REFERENCES "actors"("id"),
  "answered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "message_decisions_status_check" CHECK ("status" IN ('open', 'answered', 'withdrawn')),
  CONSTRAINT "message_decisions_attention_check" CHECK ("attention" IS NULL OR ("attention" BETWEEN 1 AND 5))
);

CREATE INDEX IF NOT EXISTS "message_decisions_open_for_idx"
  ON "message_decisions" USING gin ("for_actor_ids")
  WHERE "status" = 'open';
