-- Rollback for 0088_integrations_credentials_nullable.sql.
--
-- PRECONDITION: undone rows hold NULL credentials, which the restored NOT NULL
-- cannot accept. They are blanked to '' first. That loses nothing: an undone row's
-- secret was already zeroised, and '' is what a status-undone row reads as anyway.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_credentials_null_only_when_undone";
--> statement-breakpoint
UPDATE "integrations" SET "credentials" = '' WHERE "credentials" IS NULL;
--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "credentials" SET NOT NULL;
