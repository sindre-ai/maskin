-- Let a marketplace loop carry the loop-page settings a fresh install was missing: entry condition,
-- close condition, tags and starter targets.
--
-- One nullable jsonb column on marketplace_loops. No default and no backfill, so existing rows are
-- untouched and the ALTER only changes the catalog (adding a nullable column without a default is a
-- metadata-only change in Postgres, no table rewrite). The table is small (one row per published
-- loop) and not on the hot-tables list (see packages/db/MIGRATIONS.md).
-- Down: drizzle/down/0152_marketplace_loop_settings_down.sql.

ALTER TABLE "marketplace_loops" ADD COLUMN IF NOT EXISTS "loop_settings" jsonb;
