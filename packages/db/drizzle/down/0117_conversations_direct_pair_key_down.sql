-- Rollback for 0117. Drops the DM marker; every chat becomes topical again and the
-- code from before the marker derives the 1-1 from its participants as it did.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX IF EXISTS "conversations_direct_pair_uniq";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "direct_pair_key";
