-- Rollback for 0140_saved_views_and_chat_tags.sql. Drops the saved views and every chat's tags,
-- which cannot be rebuilt. Roll back the code that reads them first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "saved_views";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "tags";
