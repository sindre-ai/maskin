-- Persistent cooldown store — S1 of the trigger-engine fix bet
-- (bet/f46b18f7-trigger-engine). Moves the two in-memory penalty maps in
-- trigger-runner.ts (`triggerFailures`, `workspaceSuppressions`) into
-- Postgres so a server restart no longer wipes them.
--
-- Fixes bet #7 (deploy wipes cooldowns). Before this, every deploy freed
-- triggers that had been failing every minute to fire again the moment we
-- deployed — usually failing the same way and burning a session. Now the
-- backoff list is authoritative on disk; the in-memory Map remains the
-- hot-path cache.
--
-- Neither table is on the hot-table list:
--   - trigger_cooldowns is written when a trigger's session fails / succeeds
--     (order of dozens/hour workspace-wide, not per-external-request).
--   - workspace_suppressions is written at most once per workspace per
--     pause window (plan-cap or no-credentials paths).
-- Both are read at boot and by a 60s background sweep (per tech spec §3.2).

CREATE TABLE IF NOT EXISTS "trigger_cooldowns" (
	"trigger_id" uuid PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL,
	"backoff_until" timestamp with time zone NOT NULL,
	"reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_cooldowns_trigger_id_triggers_id_fk"
		FOREIGN KEY ("trigger_id") REFERENCES "triggers"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "trigger_cooldowns_backoff_until_idx"
	ON "trigger_cooldowns" ("backoff_until");

CREATE TABLE IF NOT EXISTS "workspace_suppressions" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"suppressed_until" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_suppressions_workspace_id_workspaces_id_fk"
		FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "workspace_suppressions_until_idx"
	ON "workspace_suppressions" ("suppressed_until");
