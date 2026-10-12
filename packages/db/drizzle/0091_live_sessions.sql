-- Migration: live_sessions table for Live mode (voice conversation with an agent).
--
-- One row per live call between a workspace human and an agent. The turn engine
-- streams an OpenRouter chat completion, speaks it through OpenRouter TTS and
-- runs the agent's tools in-process; no container is involved, so this is
-- deliberately not the `sessions` table.
--
-- Rows land at status='pending' on POST /api/live-sessions and move through
-- 'active' -> 'ended' | 'errored' | 'timed_out'.
--
-- The partial unique index on human_actor_id is the concurrency guard: one live
-- call per human. The database resolves the race, so the 409 branch is
-- authoritative with no application-level TOCTOU shim.
--
-- llm_route + the partial index on (workspace_id, started_at) let the plan-cap
-- aggregate (getWorkspacePlanUsdCentsUsage) sum live spend with an index scan,
-- mirroring sessions_ws_plan_usage_idx.
--
-- Idempotent: every object uses IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS "live_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "agent_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "human_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,
  "status" text NOT NULL,
  "provider" text NOT NULL DEFAULT 'openrouter',
  "input_mode" text NOT NULL,
  "llm_route" text,
  "llm_model" text,
  "tts_model" text,
  "tts_voice" text,
  "stt_model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "tts_characters" integer NOT NULL DEFAULT 0,
  "stt_seconds" integer NOT NULL DEFAULT 0,
  "llm_cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
  "tts_cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
  "stt_cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
  "total_cost_usd" numeric(12,6) NOT NULL DEFAULT 0,
  "turn_count" integer NOT NULL DEFAULT 0,
  "tool_calls_count" integer NOT NULL DEFAULT 0,
  "ended_reason" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "last_activity_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "timeout_at" timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "live_sessions_input_mode_check" CHECK ("input_mode" IN ('text','audio'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_sessions_ws_started_idx" ON "live_sessions" ("workspace_id", "started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_sessions_status_timeout_idx" ON "live_sessions" ("status", "timeout_at") WHERE "status" IN ('pending','active');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "live_sessions_active_per_human_uniq" ON "live_sessions" ("human_actor_id") WHERE "status" IN ('pending','active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_sessions_ws_plan_usage_idx" ON "live_sessions" ("workspace_id", "started_at") WHERE "llm_route" = 'maskin_plan';
