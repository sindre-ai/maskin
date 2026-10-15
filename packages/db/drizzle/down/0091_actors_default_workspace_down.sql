-- Rollback for 0091_actors_default_workspace.sql.
-- Lives under drizzle/down/ so the forward migration runner never picks it up.
-- Revert the code that reads and writes actors.default_workspace_id first.
ALTER TABLE "actors" DROP CONSTRAINT IF EXISTS "actors_default_workspace_id_workspaces_id_fk";
ALTER TABLE "actors" DROP COLUMN IF EXISTS "default_workspace_id";
