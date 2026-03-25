-- Add sessions, session_logs, and agent_files tables for container-based agent execution

CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"trigger_id" uuid REFERENCES "triggers"("id"),
	"status" text NOT NULL,
	"container_id" text,
	"action_prompt" text NOT NULL,
	"config" jsonb NOT NULL DEFAULT '{}',
	"result" jsonb,
	"snapshot_path" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "sessions_ws_status_idx" ON "sessions" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "sessions_actor_idx" ON "sessions" ("actor_id");

CREATE TABLE IF NOT EXISTS "session_logs" (
	"id" bigserial PRIMARY KEY,
	"session_id" uuid NOT NULL REFERENCES "sessions"("id"),
	"stream" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "session_logs_session_idx" ON "session_logs" ("session_id", "created_at");

CREATE TABLE IF NOT EXISTS "agent_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"file_type" text NOT NULL,
	"path" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" integer,
	"session_id" uuid REFERENCES "sessions"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	UNIQUE ("actor_id", "workspace_id", "path")
);

CREATE INDEX IF NOT EXISTS "agent_files_actor_type_idx" ON "agent_files" ("actor_id", "file_type");

-- Track which session is actively working on an object
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'objects' AND column_name = 'active_session_id') THEN
    ALTER TABLE "objects" ADD COLUMN "active_session_id" uuid REFERENCES "sessions"("id");
  END IF;
END $$;
