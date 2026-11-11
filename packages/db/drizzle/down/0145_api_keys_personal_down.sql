-- Rollback for 0145. Personal keys cannot exist under the old kind check, so they are deleted:
-- anything that used one stops authenticating. Every other key is kept.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DELETE FROM "api_keys" WHERE "kind" = 'personal';
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_kind_enum";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_enum" CHECK ("kind" IN ('primary', 'login', 'login_ios', 'session'));
--> statement-breakpoint
ALTER TABLE "api_keys" DROP COLUMN IF EXISTS "name";
