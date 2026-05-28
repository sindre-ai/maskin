-- Move webhook delivery dedup from per-(provider, delivery_id) to per-
-- (provider, delivery_id, workspace_id). A single external install can be
-- connected to multiple workspaces; the old key meant one workspace's claim
-- starved every other workspace from ever processing the delivery on retry.
--
-- TRUNCATE is safe here: this table is an ephemeral idempotency ledger with
-- ~14d retention and a real dedup horizon of ~1h (Slack's retry window).
-- Clearing it costs at most a brief window where in-flight retries during
-- deploy may be processed once more than necessary; the actual event insert
-- is itself idempotent at the application level for the use cases we care
-- about (Slack message events).
TRUNCATE TABLE "webhook_deliveries";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "workspace_id" uuid NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_provider_external_id_uniq";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_provider_external_id_workspace_id_uniq" UNIQUE ("provider", "external_id", "workspace_id");
