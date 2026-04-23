-- Migration: add interactive column to sessions
-- Marks sessions that were created with stdin-driven multi-turn mode (Claude Code
-- `--input-format stream-json`). Defaults to false; existing rows become non-interactive.
-- Idempotent — safe to re-run.

ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "interactive" boolean NOT NULL DEFAULT false;
