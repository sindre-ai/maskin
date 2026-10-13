-- Access requests (bet 823276b2, task a6eec3cc). Three things, all additive:
--   1. integrations: tier (NULL = unset, which counts as Tier 2), approver_actor_id,
--      second_approver_actor_ids. Existing rows stay unset, so every existing
--      credential is Tier 2 and an agent request for it is refused.
--   2. access_requests: one row per agent request, including the ones the route
--      refuses itself (status denied, no approver).
--   3. credential_access_log: the action CHECK learns tier_changed and the five
--      grant_* actions, and keeps scope_changed from 0091_credential_access_log_scope_changed.
--      This runs after that migration, so the CHECK lists all twelve actions. A
--      forward ALTER only. action is already hashed as text, so the trigger, the
--      hash formula and the verifier are untouched and every existing row still
--      verifies.
--
-- The new CHECK goes on NOT VALID first, then VALIDATE, so the log is never
-- scanned under a write-blocking lock. Existing rows only carry actions the
-- 0091 CHECK already allows, which are all in the new list, so VALIDATE cannot fail.
--
-- Down: drizzle/down/0092_access_requests_down.sql.

ALTER TABLE "integrations"
	ADD COLUMN IF NOT EXISTS "tier" smallint,
	ADD COLUMN IF NOT EXISTS "approver_actor_id" uuid REFERENCES "actors"("id"),
	ADD COLUMN IF NOT EXISTS "second_approver_actor_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP CONSTRAINT IF EXISTS "integrations_tier_range",
	DROP CONSTRAINT IF EXISTS "integrations_second_approvers_is_array";
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD CONSTRAINT "integrations_tier_range" CHECK ("tier" IS NULL OR "tier" IN (1, 2, 3)),
	ADD CONSTRAINT "integrations_second_approvers_is_array" CHECK (jsonb_typeof("second_approver_actor_ids") = 'array');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"requester_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id"),
	"tier" smallint NOT NULL,
	"requested_duration" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL DEFAULT 'requested',
	"approver_actor_id" uuid REFERENCES "actors"("id"),
	"decided_at" timestamp with time zone,
	"grant_id" uuid,
	"session_id" uuid REFERENCES "sessions"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "access_requests_status_enum" CHECK ("status" IN ('requested', 'approved', 'denied', 'expired', 'cancelled')),
	CONSTRAINT "access_requests_tier_range" CHECK ("tier" IN (1, 2, 3)),
	CONSTRAINT "access_requests_duration_form" CHECK ("requested_duration" = 'session' OR "requested_duration" ~ '^[1-9][0-9]{0,3}[hd]$')
);
--> statement-breakpoint
-- One open request per agent and credential. The route dedupes first; this closes the race.
CREATE UNIQUE INDEX IF NOT EXISTS "access_requests_open_uniq"
	ON "access_requests" ("requester_actor_id", "integration_id")
	WHERE "status" = 'requested';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_requests_ws_status_idx" ON "access_requests" ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "access_requests_pair_idx" ON "access_requests" ("requester_actor_id", "integration_id", "created_at");
--> statement-breakpoint
ALTER TABLE "credential_access_log" DROP CONSTRAINT IF EXISTS "credential_access_log_action_enum";
--> statement-breakpoint
ALTER TABLE "credential_access_log" ADD CONSTRAINT "credential_access_log_action_enum" CHECK ("action" IN (
	'read', 'create', 'undone', 'rotated', 'sweeper_activated', 'scope_changed',
	'tier_changed', 'grant_requested', 'grant_approved', 'grant_denied', 'grant_expired', 'grant_revoked'
)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "credential_access_log" VALIDATE CONSTRAINT "credential_access_log_action_enum";
