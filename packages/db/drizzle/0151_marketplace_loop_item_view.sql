-- Let a marketplace loop carry custom views (the extra tabs on a loop page).
--
-- marketplace_loop_items.item_type only allowed actor, trigger, skill and integration. A "view"
-- item holds a tab name and its page; install copies it into the installer's workspace as a new
-- file. Widening a check constraint only: no column changes and no data moves. The table is small
-- (one row per element of each published loop) and not on the hot-tables list (see
-- packages/db/MIGRATIONS.md). Both statements run in one go.
-- Down: drizzle/down/0151_marketplace_loop_item_view_down.sql.

ALTER TABLE "marketplace_loop_items" DROP CONSTRAINT IF EXISTS "marketplace_loop_items_item_type_check";
--> statement-breakpoint
ALTER TABLE "marketplace_loop_items" ADD CONSTRAINT "marketplace_loop_items_item_type_check" CHECK ("marketplace_loop_items"."item_type" IN ('actor', 'trigger', 'skill', 'integration', 'view'));
