-- Rollback for 0122_pg_trgm_extension.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Run 0124's rollback first: the extension cannot be dropped while the index uses it.
DROP EXTENSION IF EXISTS pg_trgm;
