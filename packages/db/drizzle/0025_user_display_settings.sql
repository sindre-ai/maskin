CREATE TABLE IF NOT EXISTS "user_display_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"object_type" text NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_display_settings_ws_actor_type_name_uniq" UNIQUE("workspace_id", "actor_id", "object_type", "name")
);
--> statement-breakpoint
ALTER TABLE "user_display_settings" ADD CONSTRAINT "user_display_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_display_settings" ADD CONSTRAINT "user_display_settings_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_display_settings_ws_actor_type_idx" ON "user_display_settings" USING btree ("workspace_id","actor_id","object_type");
