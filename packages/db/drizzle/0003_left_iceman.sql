CREATE TABLE "mcp_telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"tool_name" text NOT NULL,
	"session_id" text,
	"has_rich_render" boolean,
	"duration_ms" integer,
	"object_type" text,
	"mutation_kind" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_participants_thread_actor_uniq" UNIQUE("thread_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"focus_object_id" uuid,
	"visibility" text DEFAULT 'channel' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"kind" text DEFAULT 'discussion' NOT NULL,
	"title" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "interactive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "total_cost_usd" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cache_creation_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "cache_read_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "is_valid" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_telemetry" ADD CONSTRAINT "mcp_telemetry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_events" ADD CONSTRAINT "thread_events_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_focus_object_id_objects_id_fk" FOREIGN KEY ("focus_object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_resolved_by_actors_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_telemetry_ws_created_at_idx" ON "mcp_telemetry" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_telemetry_ws_event_type_idx" ON "mcp_telemetry" USING btree ("workspace_id","event_type","created_at");--> statement-breakpoint
CREATE INDEX "thread_events_thread_id_idx" ON "thread_events" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_events_actor_id_idx" ON "thread_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "thread_participants_thread_id_idx" ON "thread_participants" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_participants_actor_id_idx" ON "thread_participants" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "threads_workspace_id_idx" ON "threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "threads_focus_object_id_idx" ON "threads" USING btree ("focus_object_id");--> statement-breakpoint
CREATE INDEX "sessions_actor_completed_idx" ON "sessions" USING btree ("actor_id","completed_at") WHERE "sessions"."completed_at" IS NOT NULL;--> statement-breakpoint

-- PG NOTIFY trigger on thread_events — payload excludes body to stay under 8KB limit
CREATE OR REPLACE FUNCTION notify_thread_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'thread_event',
    json_build_object(
      'id', NEW.id::text,
      'thread_id', NEW.thread_id::text,
      'actor_id', NEW.actor_id::text,
      'kind', NEW.kind,
      'created_at', NEW.created_at::text
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER thread_event_notify
AFTER INSERT ON thread_events
FOR EACH ROW EXECUTE FUNCTION notify_thread_event();