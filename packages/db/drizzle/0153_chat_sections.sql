-- Chat list sections: a person's own named groups of chats.
--
-- chat_sections: one row per section, owned by one actor. Name unique per owner and workspace,
-- case-insensitive. `collapsed` is the fold state, stored with the section.
-- chat_section_items: which chat sits in which section. Keyed by (actor_id, conversation_id), so a
-- chat is in at most one section per person. The composite foreign key to
-- chat_sections(id, actor_id) keeps the item's owner equal to the section's owner.
--
-- Two new tables, nothing reads them until the new routes ship, and neither is on the hot-tables
-- list (packages/db/MIGRATIONS.md), so plain CREATE TABLE and CREATE INDEX are fine.
-- Down: drizzle/down/0153_chat_sections_down.sql.

CREATE TABLE IF NOT EXISTS "chat_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_sections_name_check" CHECK (char_length(btrim("chat_sections"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_section_items" (
	"section_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_section_items_actor_id_conversation_id_pk" PRIMARY KEY("actor_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "chat_sections" ADD CONSTRAINT "chat_sections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_sections" ADD CONSTRAINT "chat_sections_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_sections_owner_name_uniq" ON "chat_sections" USING btree ("workspace_id","actor_id",lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_sections_id_actor_uniq" ON "chat_sections" USING btree ("id","actor_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_sections_owner_position_idx" ON "chat_sections" USING btree ("workspace_id","actor_id","position");
--> statement-breakpoint
ALTER TABLE "chat_section_items" ADD CONSTRAINT "chat_section_items_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_section_items" ADD CONSTRAINT "chat_section_items_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_section_items" ADD CONSTRAINT "chat_section_items_section_owner_fk" FOREIGN KEY ("section_id","actor_id") REFERENCES "public"."chat_sections"("id","actor_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_section_items_section_idx" ON "chat_section_items" USING btree ("section_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_section_items_conversation_idx" ON "chat_section_items" USING btree ("conversation_id");
--> statement-breakpoint
-- Row-level security on, no policy: "anon" and "authenticated" are denied by default, as for every
-- other table after 0111 and 0141. The app connects as the table owner, which bypasses it.
ALTER TABLE "chat_sections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chat_section_items" ENABLE ROW LEVEL SECURITY;
