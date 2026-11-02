-- Composite index on sessions (actor_id, status).
--
-- Every session completion asks "does this agent have another live session?"
-- (SessionManager.hasOtherActiveSessions: actor_id = $1 AND id <> $2 AND status
-- IN (pending, starting, queued, running, snapshotting) LIMIT 1) so it knows
-- whether to flip the agent's state. The common answer is "no" — the session
-- that just finished was the agent's last — which with only sessions_actor_idx
-- (actor_id) meant reading the agent's entire session history to prove a
-- negative. ~57k calls in 36h, mean 80ms, max 116s. With status in the index
-- the "no" is an index-only miss.
--
-- sessions_actor_idx becomes a strict prefix of this index; it is left in place
-- here and can be dropped in a follow-up once this has been live for a while.
--
-- CREATE INDEX CONCURRENTLY per packages/db/MIGRATIONS.md Rule 1: only
-- statement in the file, IF NOT EXISTS for safe retry.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_actor_status_idx"
	ON "sessions" ("actor_id", "status");
