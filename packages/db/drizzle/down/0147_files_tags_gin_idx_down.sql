-- Rollback for 0147. The tag filters keep working, with a sequential scan.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DROP INDEX CONCURRENTLY IF EXISTS "files_tags_gin_idx";
