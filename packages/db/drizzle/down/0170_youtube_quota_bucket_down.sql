-- Rollback for 0167_youtube_quota_bucket.sql. Puts the primary key back to (quota_date, scope) and
-- drops the bucket column. Counts of the search, upload and analytics buckets are deleted first,
-- because the old key allows one row per date and scope; the data bucket rows stay. Roll back the
-- code that names the bucket in its charge statement first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DELETE FROM "youtube_quota_usage" WHERE "bucket" <> 'data';
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" DROP CONSTRAINT IF EXISTS "youtube_quota_usage_pkey";
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" DROP CONSTRAINT IF EXISTS "youtube_quota_usage_bucket_check";
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" DROP COLUMN IF EXISTS "bucket";
--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" ADD CONSTRAINT "youtube_quota_usage_pkey" PRIMARY KEY ("quota_date", "scope");
