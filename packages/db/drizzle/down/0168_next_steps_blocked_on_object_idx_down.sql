-- Rollback for 0168_next_steps_blocked_on_object_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Deletes of objects keep working without it, just slowly once the table grows.
DROP INDEX CONCURRENTLY IF EXISTS "next_steps_blocked_on_object_idx";
