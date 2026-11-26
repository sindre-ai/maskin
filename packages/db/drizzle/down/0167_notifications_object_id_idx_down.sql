-- Rollback for 0167_notifications_object_id_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Deletes of objects keep working without it, just slowly once the table grows.
DROP INDEX CONCURRENTLY IF EXISTS "notifications_object_id_idx";
