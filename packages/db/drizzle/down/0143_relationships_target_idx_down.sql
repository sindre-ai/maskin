-- Rollback for 0143_relationships_target_idx.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Everything keeps working; graph and relationship reads by target go back to scanning the table.
DROP INDEX CONCURRENTLY IF EXISTS "relationships_target_type_idx";
