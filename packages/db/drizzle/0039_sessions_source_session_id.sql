-- Add source_session_id to sessions so a continuation session can restore
-- the workspace snapshot from a prior session that failed to push its work.
-- Nullable, no FK constraint (sessions can reference other sessions by id).

ALTER TABLE "sessions" ADD COLUMN "source_session_id" uuid;
