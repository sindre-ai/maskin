-- Rollback for 0146_objects_title_trgm_plain_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Object search gets slower again (a scan of the workspace per word) but keeps working.
DROP INDEX CONCURRENTLY IF EXISTS "objects_title_trgm_idx";
