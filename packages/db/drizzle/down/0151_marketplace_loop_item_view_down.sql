-- Reverts 0151_marketplace_loop_item_view.sql.
-- View items cannot stay once the constraint is narrowed, so they are removed first. Installs keep
-- the files and tabs they already created; only the catalog copies go, and the next seed
-- (a version bump) republishes the loops without views.
--
-- Lives under drizzle/down/ so the forward runner never sees it.

DELETE FROM "marketplace_loop_items" WHERE "item_type" = 'view';
--> statement-breakpoint
ALTER TABLE "marketplace_loop_items" DROP CONSTRAINT IF EXISTS "marketplace_loop_items_item_type_check";
--> statement-breakpoint
ALTER TABLE "marketplace_loop_items" ADD CONSTRAINT "marketplace_loop_items_item_type_check" CHECK ("marketplace_loop_items"."item_type" IN ('actor', 'trigger', 'skill', 'integration'));
