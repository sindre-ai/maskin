-- sessions.agent_server_id — pointer to the agent-server that a production
-- session was dispatched to. Nullable: local-dev sessions stay on Docker via
-- session-manager and never set it; only dispatcher (T6) writes it after a
-- successful POST to apps/agent-server.
--
-- Lets SessionDispatcher run the least-loaded query without scanning every
-- in-flight session row:
--   SELECT s.id, s.url, COALESCE(c.active, 0)::float / s.max_concurrent_sessions AS load
--   FROM agent_servers s
--   LEFT JOIN LATERAL (
--     SELECT COUNT(*) AS active
--     FROM sessions
--     WHERE agent_server_id = s.id AND status IN ('starting', 'running')
--   ) c ON true
--   WHERE s.status = 'active'
--   ORDER BY load ASC, s.id ASC
--   LIMIT 1;

ALTER TABLE "sessions" ADD COLUMN "agent_server_id" uuid;

--> statement-breakpoint

ALTER TABLE "sessions"
	ADD CONSTRAINT "sessions_agent_server_id_fk"
	FOREIGN KEY ("agent_server_id") REFERENCES "agent_servers" ("id");

--> statement-breakpoint

-- Hot path for least-loaded lookup: counts active sessions per server.
CREATE INDEX IF NOT EXISTS "sessions_agent_server_active_idx"
	ON "sessions" ("agent_server_id", "status")
	WHERE "agent_server_id" IS NOT NULL;
