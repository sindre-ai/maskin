-- Migration: make agent_files.actor_id nullable to support workspace-scoped files (team skills)
-- Idempotent — safe to re-run.

-- Step 1: Drop NOT NULL on actor_id so NULL can represent workspace-scoped rows.
ALTER TABLE "agent_files" ALTER COLUMN "actor_id" DROP NOT NULL;

-- Step 2: Replace the single unique constraint with two partial unique indexes.
-- Postgres treats NULLs as distinct in a regular UNIQUE constraint, so we need
-- two partial indexes to enforce uniqueness cleanly in both scopes.
ALTER TABLE "agent_files" DROP CONSTRAINT IF EXISTS "agent_files_actor_path_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "agent_files_actor_path_uniq"
	ON "agent_files" ("actor_id", "workspace_id", "path")
	WHERE "actor_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_files_workspace_path_uniq"
	ON "agent_files" ("workspace_id", "path")
	WHERE "actor_id" IS NULL;
