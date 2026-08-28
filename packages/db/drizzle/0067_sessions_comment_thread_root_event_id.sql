-- Promotes config.comment_thread.thread_root_event_id to a real, indexable
-- column — the comment-thread analogue of 0052's conversation_id. Needed so
-- the comment router's "does a running interactive session already exist for
-- this (thread root, agent)?" lookup doesn't do an unindexed JSONB path scan.
--
-- No FK to "events": adding one would need a validating scan of "sessions"
-- plus a lock on "events", and comment events are never deleted.
-- Nullable/no default: cheap ALTER, no table rewrite, no lock beyond a brief
-- catalog update even on a large table.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "comment_thread_root_event_id" bigint;
