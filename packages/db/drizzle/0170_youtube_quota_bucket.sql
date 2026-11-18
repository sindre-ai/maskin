-- Quota buckets for the YouTube Data API (bet "YouTube integration", part 2 task "Agent can search
-- YouTube and read public channels and videos"). Google meters search.list and videos.insert in
-- their own daily buckets, apart from the 10,000 unit budget everything else shares, so the count
-- needs a bucket next to the date and scope.
--
-- youtube_quota_usage gains bucket (data, search, upload, analytics), and the primary key becomes
-- (quota_date, scope, bucket). Rows that exist today are data rows, which is what the default says.
-- analytics is listed now so the analytics part needs no second change to the check.
--
-- Small and additive: the table was created empty in 0166, holds only a date, a scope and a count,
-- and is not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine and there is nothing
-- to backfill. The charge statement in the app names the new key in ON CONFLICT, so deploy this
-- migration together with the code that uses it.
-- Down: drizzle/down/0170_youtube_quota_bucket_down.sql.

ALTER TABLE "youtube_quota_usage" ADD COLUMN IF NOT EXISTS "bucket" text NOT NULL DEFAULT 'data';
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" DROP CONSTRAINT IF EXISTS "youtube_quota_usage_bucket_check";
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" ADD CONSTRAINT "youtube_quota_usage_bucket_check" CHECK ("bucket" IN ('data', 'search', 'upload', 'analytics'));
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" DROP CONSTRAINT IF EXISTS "youtube_quota_usage_pkey";
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" ADD CONSTRAINT "youtube_quota_usage_pkey" PRIMARY KEY ("quota_date", "scope", "bucket");
