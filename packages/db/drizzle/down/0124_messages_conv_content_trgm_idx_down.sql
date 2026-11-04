-- Rollback for 0124_messages_conv_content_trgm_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Search gets slower again (a scan per word) but keeps working. The extensions stay.
DROP INDEX CONCURRENTLY IF EXISTS "messages_conv_content_trgm_idx";
