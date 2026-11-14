-- Rollback for 0153_events_ws_id_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- The replay keeps working without it: it falls back to walking the primary key, correct but slow
-- from an old cursor.
DROP INDEX CONCURRENTLY IF EXISTS "events_ws_id_idx";
