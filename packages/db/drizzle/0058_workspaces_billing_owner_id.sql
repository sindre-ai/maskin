-- Single accountable human payer for a workspace's plan, distinct from
-- workspaceMembers.role='owner' (access control; many allowed per workspace).
-- Nullable-first per MIGRATIONS.md Rule 3 — backfilled in the next migration,
-- NOT NULL added later in a separate, manually-verified follow-up. Plain
-- CREATE INDEX is fine here: `workspaces` is not on the hot-tables list in
-- MIGRATIONS.md (no external webhook writes it synchronously).
ALTER TABLE "workspaces" ADD COLUMN "billing_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspaces"
	ADD CONSTRAINT "workspaces_billing_owner_id_actors_id_fk"
	FOREIGN KEY ("billing_owner_id") REFERENCES "public"."actors"("id")
	ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_billing_owner_idx"
	ON "workspaces" ("billing_owner_id");
