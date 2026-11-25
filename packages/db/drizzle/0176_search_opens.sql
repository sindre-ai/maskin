-- Search frecency (task "Boost often-opened results in Cmd+K"). One row per person and result they
-- opened from a search: decayed_opens is the open count with the age already folded in (every
-- open adds 1 after the old value has been halved per 14 days), last_opened_at says when that
-- value was current. Search reads decayed_opens * 0.5^(days since last_opened_at / 14).
-- entity_id carries no foreign key: it points at a chat, object, agent or person, so no single
-- table owns it, and a row for a deleted result is harmless. workspace and actor cascade.
-- New, empty table, additive, not on the hot-tables list (see MIGRATIONS.md), so plain DDL is fine.
-- Row-level security is switched on because 0111_enable_rls_public_tables ran before it existed.
-- Down: drizzle/down/0176_search_opens_down.sql.

CREATE TABLE IF NOT EXISTS "search_opens" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"actor_id" uuid NOT NULL REFERENCES "actors"("id") ON DELETE CASCADE,
	"entity_id" uuid NOT NULL,
	"decayed_opens" double precision NOT NULL DEFAULT 0,
	"last_opened_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("workspace_id", "actor_id", "entity_id")
);
--> statement-breakpoint
ALTER TABLE "search_opens" ENABLE ROW LEVEL SECURITY;
