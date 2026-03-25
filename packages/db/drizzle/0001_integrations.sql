-- Add integrations table for external service connections (GitHub, Slack, etc.)

CREATE TABLE IF NOT EXISTS "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"external_id" text,
	"credentials" text NOT NULL,
	"config" jsonb NOT NULL DEFAULT '{}',
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	UNIQUE ("workspace_id", "provider")
);

CREATE INDEX IF NOT EXISTS "integrations_external_id_idx" ON "integrations" ("provider", "external_id");
