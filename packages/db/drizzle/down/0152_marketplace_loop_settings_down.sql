-- Reverts 0152_marketplace_loop_settings.sql.
-- Installs keep the conditions, tags and targets already copied onto their loop objects; only the
-- catalog copy goes, and the next seed (a version bump) republishes the loops without settings.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "marketplace_loops" DROP COLUMN IF EXISTS "loop_settings";
