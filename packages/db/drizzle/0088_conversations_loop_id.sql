-- Loop chat: one group conversation per loop. Nullable so every existing
-- conversation (and every non-loop chat) is untouched. The partial unique
-- index is what makes get-or-create idempotent under concurrent first opens.
ALTER TABLE "conversations"
	ADD COLUMN IF NOT EXISTS "loop_id" uuid REFERENCES "objects"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_loop_id_uniq"
	ON "conversations" ("loop_id") WHERE "loop_id" IS NOT NULL;
