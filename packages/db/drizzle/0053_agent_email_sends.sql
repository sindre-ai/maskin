-- Per-send audit row backing the two hardening gates on the agent
-- `send_email` tool (bet: Product email infrastructure, T7):
--
--   1. Idempotency — an optional client-supplied `idempotency_key` lets the
--      same call replay safely. The partial unique index on
--      (workspace_id, actor_id, idempotency_key) makes a duplicate INSERT
--      raise `23505` inside the tool, which returns `{ ok: false,
--      error: "already_sent" }` without hitting Resend. Rows without a
--      key are excluded from the constraint so keyless sends never
--      collide.
--
--   2. Per-agent rate limit — a rolling-hour ceiling
--      (`AGENT_EMAIL_RATE_LIMIT_PER_HOUR`, default 10) checked before the
--      workspace-member allowlist so an attacker can't burn the counter
--      on invalid recipients. The window count is a straight
--      `count(*) WHERE actor_id = ? AND sent_at >= now() - '1 hour'`,
--      served by `agent_email_sends_actor_sent_at_idx`.
--
-- One row per successful Resend dispatch. On dispatch failure we do NOT
-- write, so a retry is free (subject only to the rate limit).
--
-- Not a hot table by the definition in packages/db/MIGRATIONS.md — writes
-- ride the agent send path, not an external webhook — so plain
-- `CREATE INDEX` is fine here (no CONCURRENTLY needed).

CREATE TABLE IF NOT EXISTS "agent_email_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"idempotency_key" text,
	"provider_message_id" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_email_sends_workspace_actor_key_uniq"
	ON "agent_email_sends" ("workspace_id", "actor_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "agent_email_sends_actor_sent_at_idx"
	ON "agent_email_sends" ("actor_id", "sent_at");
