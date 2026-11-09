-- Rollback for 0145_sessions_actor_created_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; last-active reads go back to reading every session of the actor.
DROP INDEX CONCURRENTLY IF EXISTS "sessions_actor_created_at_idx";
