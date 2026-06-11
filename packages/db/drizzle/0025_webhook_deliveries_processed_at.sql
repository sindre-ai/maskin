-- Track when a claim's downstream work (event insert + any fan-out side effects)
-- completed. The webhook route now sets `processed_at` in the same transaction
-- as the events insert. The reconciler (apps/dev/src/services/webhook-deliveries-reconciler.ts)
-- releases claims that remain NULL beyond the configured threshold so the
-- provider's next retry can reprocess them. Without this, a Slack fire-and-
-- forget fan-out interrupted by a deploy / OOM left the claim committed and
-- the next retry was silently deduped — see CTO follow-up on PR #492.
ALTER TABLE "webhook_deliveries" ADD COLUMN "processed_at" timestamp with time zone;
--> statement-breakpoint
-- Backfill: any existing rows predate the reconciler and have either already
-- been processed or are far past any retry window. Mark them processed to
-- avoid the first reconciler tick treating them as orphans.
UPDATE "webhook_deliveries" SET "processed_at" = "received_at" WHERE "processed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "webhook_deliveries_unprocessed_received_at_idx"
	ON "webhook_deliveries" USING btree ("received_at")
	WHERE "processed_at" IS NULL;
