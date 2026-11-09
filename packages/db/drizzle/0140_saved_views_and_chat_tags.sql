-- Tags on chats, and shared saved views for flows, agents and chats.
--
-- conversations.tags: a JSON array of short labels, empty by default. Adding a column with a
-- constant default does not rewrite the table (Postgres 11+), and conversations is not on the
-- hot-tables list (packages/db/MIGRATIONS.md), so a plain ALTER is fine.
--
-- saved_views: new table, nothing reads it until the new routes ship. One name per kind in a
-- workspace (case-insensitive), kind and group_by limited to the values the routes accept.
-- Down: drizzle/down/0140_saved_views_and_chat_tags_down.sql.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_by" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_kind_check" CHECK ("saved_views"."kind" IN ('flow', 'agent', 'chat')),
	CONSTRAINT "saved_views_group_by_check" CHECK ("saved_views"."group_by" IS NULL OR "saved_views"."group_by" IN ('tag', 'driver'))
);
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_created_by_actors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."actors"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "saved_views_ws_kind_name_uniq" ON "saved_views" USING btree ("workspace_id","kind",lower("name"));
