-- Create all tables

CREATE TABLE IF NOT EXISTS "actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"type" text NOT NULL,
	"name" text NOT NULL,
	"email" text UNIQUE,
	"api_key_hash" text,
	"system_prompt" text,
	"tools" jsonb,
	"memory" jsonb,
	"llm_provider" text,
	"llm_config" jsonb,
	"created_by" uuid REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"settings" jsonb NOT NULL DEFAULT '{}',
	"created_by" uuid REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "workspace_members" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now(),
	PRIMARY KEY ("workspace_id", "actor_id")
);

CREATE TABLE IF NOT EXISTS "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"type" text NOT NULL,
	"title" text,
	"content" text,
	"status" text NOT NULL,
	"metadata" jsonb,
	"owner" uuid REFERENCES "actors"("id"),
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "objects_ws_type_status_idx" ON "objects" ("workspace_id", "type", "status");

CREATE TABLE IF NOT EXISTS "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"type" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	UNIQUE ("source_id", "target_id", "type")
);

CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "events_ws_created_at_idx" ON "events" ("workspace_id", "created_at");

CREATE TABLE IF NOT EXISTS "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id"),
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"action_prompt" text NOT NULL,
	"target_actor_id" uuid NOT NULL REFERENCES "actors"("id"),
	"enabled" boolean NOT NULL DEFAULT true,
	"created_by" uuid NOT NULL REFERENCES "actors"("id"),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);

-- PG NOTIFY trigger: fires on every event insert, broadcasts to SSE
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
	PERFORM pg_notify('events', json_build_object(
		'event_id', NEW.id::text,
		'workspace_id', NEW.workspace_id::text,
		'actor_id', NEW.actor_id::text,
		'action', NEW.action,
		'entity_type', NEW.entity_type,
		'entity_id', NEW.entity_id::text,
		'data', NEW.data
	)::text);
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER events_notify
	AFTER INSERT ON "events"
	FOR EACH ROW
	EXECUTE FUNCTION notify_event();
