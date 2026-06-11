-- Migration: add agent_state column to actors so the agent overview page
-- can render running / paused / idle / failed without inspecting every session.
-- Idempotent — safe to re-run.

ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "agent_state" text NOT NULL DEFAULT 'idle';

ALTER TABLE "actors" ADD COLUMN IF NOT EXISTS "agent_state_updated_at" timestamp with time zone;

ALTER TABLE "actors"
  DROP CONSTRAINT IF EXISTS "actors_agent_state_check";

ALTER TABLE "actors"
  ADD CONSTRAINT "actors_agent_state_check"
  CHECK ("agent_state" IN ('idle', 'running', 'paused', 'failed'));
