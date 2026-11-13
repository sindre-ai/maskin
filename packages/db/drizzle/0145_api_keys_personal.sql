-- Named personal API keys (Keys and MCP page): a person can make several keys by hand, each with a
-- name, and revoke any of them.
--
-- 1. api_keys.name: the label a person gave a personal key. Null on every other kind. Nullable and
--    added with no default, so it is a catalog-only change with no table rewrite.
-- 2. The kind check gains 'personal'. The new constraint is added NOT VALID and then validated in
--    its own statement: VALIDATE only takes a SHARE UPDATE EXCLUSIVE lock, so key lookups on the
--    request path keep running while existing rows are checked.
-- Existing keys are untouched, nothing is rotated, and no secret is stored differently: a personal
-- key is hashed like every other.
-- Down: drizzle/down/0145_api_keys_personal_down.sql.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "name" text;
--> statement-breakpoint
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_kind_enum";
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_kind_enum" CHECK ("kind" IN ('primary', 'login', 'login_ios', 'session', 'personal')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "api_keys" VALIDATE CONSTRAINT "api_keys_kind_enum";
