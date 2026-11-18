-- Rollback for 0166_youtube_quota_usage.sql. Drops the daily YouTube quota counts. Nothing else
-- depends on the table; the count restarts from zero, so roll back the code that writes it first.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP TABLE IF EXISTS "youtube_quota_usage";
