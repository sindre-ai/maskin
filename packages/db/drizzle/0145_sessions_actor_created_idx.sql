-- "When was this agent last active?" (lib/member-last-active.ts) runs
-- MAX(created_at) ... GROUP BY actor_id over sessions. sessions_actor_idx finds the actor's rows
-- but the maximum still has to read every one of them; with (actor_id, created_at DESC) the
-- newest session per actor is the first entry in the index.
--
-- Alone in its file: CREATE INDEX CONCURRENTLY cannot share a transaction with other statements
-- (see packages/db/MIGRATIONS.md Rule 1). If an interrupted build leaves an INVALID index, drop it
-- first. Down: drizzle/down/0145_sessions_actor_created_idx_down.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_actor_created_at_idx"
  ON "sessions" USING btree ("actor_id", "created_at" DESC);
