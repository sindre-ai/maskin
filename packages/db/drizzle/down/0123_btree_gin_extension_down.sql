-- Rollback for 0123_btree_gin_extension.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Run 0124's rollback first: the extension cannot be dropped while the index uses it.
DROP EXTENSION IF EXISTS btree_gin;
