-- Migration: add model_name column to sessions
-- Records the OpenRouter model id (e.g. `deepseek/deepseek-v4-flash`) that
-- actually ran the session. Stamped at spawn on the maskin_plan route from
-- MASKIN_FALLBACK_MODEL; null on every other route (claude_oauth and BYO
-- paths keep pricing off Claude Code's own `total_cost_usd`).
-- Load-bearing for the local cost resolver that will price maskin_plan
-- sessions off OpenRouter's per-token pricing keyed on this value.
-- Idempotent — safe to re-run.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "model_name" text;
