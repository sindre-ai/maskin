-- Rollback for 0108. Drops the hashed keys and restores NOT NULL on actors.api_key.
--
-- Actors created after 0108 have no plaintext key (it was no longer written), so they get an
-- unusable placeholder here: they exist but cannot authenticate until a key is regenerated.
-- Keys minted after 0108 for existing actors (logins, sessions) are lost with the table.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

UPDATE "actors" SET "api_key" = 'rolledback_' || replace(gen_random_uuid()::text, '-', '') WHERE "api_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "actors" ALTER COLUMN "api_key" SET NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS "api_keys";
