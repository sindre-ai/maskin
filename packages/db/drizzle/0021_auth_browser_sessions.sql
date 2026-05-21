CREATE TABLE "auth_browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"container_id" text,
	"network_name" text,
	"access_token" text NOT NULL,
	"captured_credentials" text,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "auth_browser_sessions" ADD CONSTRAINT "auth_browser_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "auth_browser_sessions" ADD CONSTRAINT "auth_browser_sessions_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "auth_browser_sessions_ws_idx" ON "auth_browser_sessions" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX "auth_browser_sessions_expires_idx" ON "auth_browser_sessions" USING btree ("expires_at");
