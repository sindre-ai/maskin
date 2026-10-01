-- Migration: voice_sessions table for Voice v1 (bet 16bd0042)
--
-- Tracks a live 1:1 voice session between a workspace member and an agent.
-- Rows land at status='pending' on the session-mint route (POST /api/voice-sessions)
-- and move through 'active' → 'ended' via subsequent lifecycle routes (Tasks 3/4).
--
-- The unique index on human_actor_id (partial, status in ('pending','active'))
-- is the concurrency guard: one live session per human at a time. Race is
-- resolved at the DB level so the 409 branch is authoritative (never a TOCTOU
-- shim in application code).
--
-- Idempotent: all objects use IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS "voice_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "human_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "vendor" text NOT NULL DEFAULT 'openai_realtime',
  "vendor_session_id" text,
  "model" text,
  "transcript_storage_key" text,
  "input_audio_seconds" integer,
  "output_audio_seconds" integer,
  "input_tokens" integer,
  "output_tokens" integer,
  "total_cost_usd" numeric(12,6),
  "ended_reason" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "timeout_at" timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_sessions_ws_started_idx" ON "voice_sessions" ("workspace_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_sessions_status_timeout_idx" ON "voice_sessions" ("status", "timeout_at") WHERE "status" IN ('pending','active');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_sessions_active_per_human_uniq" ON "voice_sessions" ("human_actor_id") WHERE "status" IN ('pending','active');
