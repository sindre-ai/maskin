-- Rollback for 0129_objects_title_trgm_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Search gets slower again (one scan of every object body for the first word) but keeps working.
-- The extensions stay.
DROP INDEX CONCURRENTLY IF EXISTS "objects_ws_title_trgm_idx";
