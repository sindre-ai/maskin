-- Rollback for 0134_sessions_open_status_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The watchdog's status lookups go back to reading the whole table (slow, but correct).
DROP INDEX CONCURRENTLY IF EXISTS "sessions_open_status_idx";
