-- Daily quota counter for the YouTube Data API (bet "YouTube integration", task "Agent can read the
-- connected channel"). Google gives the whole Maskin project one budget a day, so the count is a
-- table, not a counter on the integration row.
--
-- youtube_quota_usage: one row per (quota_date, scope). quota_date is the Pacific date, because
-- Google resets quota at midnight Pacific; the writer computes it in SQL from the database clock.
-- scope is the word global or a workspace id (plain text, no foreign key, so the row outlives the
-- workspace and the count stays honest for the day). units_used is the units charged so far.
-- The table holds no YouTube user data, only a date, a scope and a count.
--
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine
-- and there is nothing to backfill. Row-level security is switched on because
-- 0111_enable_rls_public_tables ran before this table existed.
-- Down: drizzle/down/0166_youtube_quota_usage_down.sql.

CREATE TABLE IF NOT EXISTS "youtube_quota_usage" (
	"quota_date" date NOT NULL,
	"scope" text NOT NULL,
	"units_used" integer NOT NULL DEFAULT 0,
	CONSTRAINT "youtube_quota_usage_pkey" PRIMARY KEY ("quota_date", "scope"),
	CONSTRAINT "youtube_quota_usage_units_check" CHECK ("units_used" >= 0)
);
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" ENABLE ROW LEVEL SECURITY;
