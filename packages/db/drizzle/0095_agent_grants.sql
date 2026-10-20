-- Agent grants: which agents may use an integration, and how.
--
-- Replaces integrations.scope_grants (a JSONB list of actor/loop/workspace grants that
-- only ever said "may read"). A grant is now a row: (integration, agent, access) with
-- access read | write | read_write. integrations.default_agent_access says what an
-- agent with NO row gets: 'read' for ordinary integrations, 'none' for Keychain
-- credentials (bring-your-own keys and logins stay explicit-grant, fail-closed).
--
-- Carried over: every actor-kind grant becomes a read_write row. Workspace-kind grants
-- (google-meet, linkedin-unipile) are dropped on purpose; those providers now follow
-- the default-read rule. Loop-kind grants matched nothing at launch and are dropped.
-- Down: drizzle/down/0095_agent_grants_down.sql.

CREATE TABLE IF NOT EXISTS "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"integration_id" uuid NOT NULL REFERENCES "integrations"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"access" text NOT NULL,
	"created_by" uuid REFERENCES "actors"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "agent_grants_access_enum" CHECK ("access" IN ('read', 'write', 'read_write')),
	CONSTRAINT "agent_grants_integration_actor_uniq" UNIQUE ("integration_id", "actor_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_grants_ws_actor_idx" ON "agent_grants" ("workspace_id", "actor_id");
--> statement-breakpoint
ALTER TABLE "integrations"
	ADD COLUMN IF NOT EXISTS "default_agent_access" text NOT NULL DEFAULT 'read';
--> statement-breakpoint
ALTER TABLE "integrations"
	DROP CONSTRAINT IF EXISTS "integrations_default_agent_access_enum",
	ADD CONSTRAINT "integrations_default_agent_access_enum" CHECK ("default_agent_access" IN ('read', 'none'));
--> statement-breakpoint
UPDATE "integrations" SET "default_agent_access" = 'none'
	WHERE "provider_mode" IN ('byo_apikey', 'byo_login', 'byo_oauth');
--> statement-breakpoint
-- Guarded so a second run, after scope_grants is gone, does nothing.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = current_schema() AND table_name = 'integrations' AND column_name = 'scope_grants'
	) THEN
		INSERT INTO "agent_grants" ("workspace_id", "integration_id", "actor_id", "access", "created_by")
		SELECT i."workspace_id", i."id", (g.value ->> 'actorId')::uuid, 'read_write', i."created_by"
		FROM "integrations" i
		CROSS JOIN LATERAL jsonb_array_elements(i."scope_grants") AS g(value)
		WHERE g.value ->> 'kind' = 'actor'
			AND EXISTS (SELECT 1 FROM "actors" a WHERE a."id" = (g.value ->> 'actorId')::uuid)
		ON CONFLICT ("integration_id", "actor_id") DO NOTHING;
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "integrations" DROP CONSTRAINT IF EXISTS "integrations_scope_grants_is_array";
--> statement-breakpoint
ALTER TABLE "integrations" DROP COLUMN IF EXISTS "scope_grants";
