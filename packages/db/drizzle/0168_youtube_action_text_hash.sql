-- YouTube write tools (bet "YouTube integration", part 4, task "Agent can propose metadata,
-- thumbnail, playlist, comment and like changes"). One new nullable column on the pending actions
-- table: text_hash, the sha256 of a comment's normalized text. It lets the rule "no identical
-- comment twice" hold after the action ends and its payload is cleared, without keeping the text
-- itself. Null for every other kind of action and for rows made before this column.
--
-- The table is new and small and not on the hot-tables list (see MIGRATIONS.md), so plain DDL is
-- fine and there is nothing to backfill. The index is partial: only comment rows carry a hash.
-- Down: drizzle/down/0168_youtube_action_text_hash_down.sql.

ALTER TABLE "youtube_pending_actions" ADD COLUMN IF NOT EXISTS "text_hash" text;

CREATE INDEX IF NOT EXISTS "youtube_pending_actions_text_hash_idx"
	ON "youtube_pending_actions" ("workspace_id", "text_hash")
	WHERE "text_hash" IS NOT NULL;
