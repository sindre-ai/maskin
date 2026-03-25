CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"metadata" jsonb,
	"source_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"target_actor_id" uuid REFERENCES "actors"("id"),
	"object_id" uuid REFERENCES "objects"("id") ON DELETE SET NULL,
	"session_id" uuid REFERENCES "sessions"("id"),
	"status" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_ws_status_idx" ON "notifications" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "notifications_target_actor_idx" ON "notifications" ("target_actor_id", "status");
