-- Migration: per-session cost & token telemetry columns.
-- Captures the final stream-json `result` event from Claude Code so we can
-- aggregate spend per agent over time. Columns are nullable — Codex / custom
-- runtimes don't emit structured usage and rows simply stay NULL.
--
-- The partial index is the workhorse for the agent usage chart: it lets
-- date_trunc(...) GROUP BY queries scoped to (actor_id, completed_at range)
-- run as cheap index range scans even at high session counts.
--
-- Idempotent — safe to re-run.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "total_cost_usd"              numeric(12, 6),
  ADD COLUMN IF NOT EXISTS "input_tokens"                integer,
  ADD COLUMN IF NOT EXISTS "output_tokens"               integer,
  ADD COLUMN IF NOT EXISTS "cache_creation_input_tokens" integer,
  ADD COLUMN IF NOT EXISTS "cache_read_input_tokens"     integer,
  ADD COLUMN IF NOT EXISTS "duration_ms"                 integer;

CREATE INDEX IF NOT EXISTS "sessions_actor_completed_idx"
  ON "sessions" ("actor_id", "completed_at")
  WHERE "completed_at" IS NOT NULL;
